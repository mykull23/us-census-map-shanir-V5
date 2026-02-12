// ============================================================================
// ACS API SERVICE - ENHANCED WITH 24-HOUR CACHE TTL & CORS PROXY
// ============================================================================

class ACSAPIService {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.census.gov/data/2022/acs/acs5';
        this.cacheDuration = 90 * 24 * 60 * 60 * 1000; // 24 hours (changed from 90 days)
        this.batchSize = 30; // Reduced to avoid URL length limits
        this.cachePrefix = 'acs_2022_';
        this.proxyUrls = [
            'https://corsproxy.io/?',
            'https://api.allorigins.win/raw?url=',
            ''
        ];
        this.currentProxyIndex = 0;
        
        this.dbName = 'acs_data_cache_v3'; // Incremented version
        this.storeName = 'census_data';
        this.db = null;
        this.cachePromise = null;
        
        this.stats = {
            cacheHits: 0,
            cacheMisses: 0,
            apiCalls: 0,
            bytesSaved: 0
        };
        
        // Memory cache for frequently accessed data
        this.memoryCache = new Map();
        this.memoryCacheSize = 500;
    }

    // Initialize with Promise caching
    async ensureInitialized() {
        if (this.cachePromise) {
            return this.cachePromise;
        }
        
        this.cachePromise = new Promise((resolve) => {
            const request = indexedDB.open(this.dbName, 3);
            
            request.onerror = () => {
                console.warn('IndexedDB initialization failed, using memory cache only');
                resolve();
            };
            
            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log('IndexedDB cache initialized (24-hour TTL)');
                this.cleanExpiredCache().then(resolve);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'key' });
                    store.createIndex('zip', 'zip', { unique: false });
                    store.createIndex('expiry', 'expiry', { unique: false });
                }
            };
        });
        
        return this.cachePromise;
    }

    // Enhanced fetch with CORS proxy fallback
    async fetchWithCorsFallback(url, options = {}, retryCount = 0) {
        const proxy = this.proxyUrls[this.currentProxyIndex];
        const fetchUrl = proxy ? (proxy === this.proxyUrls[2] ? url : `${proxy}${encodeURIComponent(url)}`) : url;
        
        try {
            this.stats.apiCalls++;
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
            
            const response = await fetch(fetchUrl, {
                ...options,
                signal: controller.signal,
                mode: 'cors',
                credentials: 'omit',
                headers: {
                    'Accept': 'application/json',
                    ...options.headers
                }
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`HTTP error: ${response.status}`);
            }
            
            return await response.json();
            
        } catch (error) {
            console.warn(`Fetch attempt ${retryCount + 1} failed:`, error.message);
            
            // Try next proxy if available
            if (retryCount < this.proxyUrls.length - 1) {
                this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxyUrls.length;
                console.log(`Switching to proxy ${this.currentProxyIndex + 1}/${this.proxyUrls.length}`);
                return this.fetchWithCorsFallback(url, options, retryCount + 1);
            }
            
            throw error;
        }
    }

    // Enhanced batch fetching with memory cache
    async fetchCombinedData(zipCodes) {
        if (!zipCodes || zipCodes.length === 0) return {};
        
        console.log(`Fetching ${zipCodes.length} ZIP codes (24-hour cache TTL)`);
        
        await this.ensureInitialized();
        
        const results = new Map();
        const missingZips = [];
        const uniqueZips = [...new Set(zipCodes)];
        
        // Process in smaller chunks
        const chunks = this.chunkArray(uniqueZips, 300);
        for (const chunk of chunks) {
            await this.processChunk(chunk, results, missingZips);
        }
        
        console.log(`Cache stats: ${results.size} hits, ${missingZips.length} misses`);
        
        // Fetch missing data in optimized batches
        if (missingZips.length > 0) {
            // Notify that we're fetching
            if (window.acsApp) {
                window.acsApp.showNotification(`Fetching ${missingZips.length} ZIP codes from Census API...`, 'loading');
            }
            
            const missingData = await this.fetchMissingData(missingZips);
            
            for (const [zip, data] of Object.entries(missingData)) {
                results.set(zip, data);
                await this.cacheData(zip, data);
                this.addToMemoryCache(zip, data);
            }
            
            if (window.acsApp) {
                window.acsApp.hideNotification('loading');
            }
        }
        
        this.logCacheStats();
        
        const resultObj = {};
        for (const [zip, data] of results) {
            resultObj[zip] = data;
        }
        
        return resultObj;
    }

    async processChunk(zipChunk, results, missingZips) {
        const promises = zipChunk.map(async (zip) => {
            const memoryCached = this.memoryCache.get(zip);
            if (memoryCached) {
                results.set(zip, memoryCached);
                this.stats.cacheHits++;
                return;
            }
            
            const cached = await this.getFromCache(zip);
            if (cached) {
                results.set(zip, cached);
                this.addToMemoryCache(zip, cached);
                this.stats.cacheHits++;
            } else {
                missingZips.push(zip);
                this.stats.cacheMisses++;
            }
        });
        
        await Promise.all(promises);
    }

    async fetchMissingData(zipCodes) {
        if (zipCodes.length === 0) return {};
        
        const results = {};
        const batches = this.chunkArray(zipCodes, this.batchSize);
        
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            
            try {
                const batchData = await this.fetchBatchFromAPI(batch);
                Object.assign(results, batchData);
                
                // Batch cache the results
                const cachePromises = Object.entries(batchData).map(([zip, data]) => 
                    this.cacheData(zip, data)
                );
                await Promise.all(cachePromises);
                
            } catch (error) {
                console.error(`Batch ${i + 1} failed:`, error.message);
            }
        }
        
        return results;
    }

    async fetchBatchFromAPI(zipCodes) {
        if (zipCodes.length === 0) return {};
        
        const variables = [
            'B15003_022E', 'B15003_023E', 'B15003_024E', 'B15003_025E', // Bachelor's, Master's, Professional, Doctorate
            'B19001_014E', 'B19001_015E', 'B19001_016E', 'B19001_017E', // $100k-124,999, $125k-149,999, $150k-199,999, $200k+
            'B19013_001E' // Median household income
        ];
        
        const zipsStr = zipCodes.join(',');
        const variablesStr = variables.join(',');
        
        const url = `${this.baseUrl}?get=NAME,${variablesStr}&for=zip%20code%20tabulation%20area:${zipsStr}&key=${this.apiKey}`;
        
        try {
            console.log(`Fetching batch of ${zipCodes.length} ZIP codes...`);
            const data = await this.fetchWithCorsFallback(url);
            return this.parseResponse(data, zipCodes);
            
        } catch (error) {
            console.error('API fetch failed:', error);
            
            // Fallback: Try with smaller batch
            if (zipCodes.length > 5) {
                console.log('Trying with smaller batch size...');
                const smallerBatches = this.chunkArray(zipCodes, 5);
                const results = {};
                
                for (const smallBatch of smallerBatches) {
                    try {
                        const smallResult = await this.fetchBatchFromAPI(smallBatch);
                        Object.assign(results, smallResult);
                    } catch (smallError) {
                        console.error('Small batch failed:', smallError);
                    }
                }
                
                return results;
            }
            
            throw error;
        }
    }

    parseResponse(data, requestedZips) {
        if (!Array.isArray(data) || data.length === 0) {
            return {};
        }
        
        const headers = data[0];
        const results = {};
        const requestedSet = new Set(requestedZips);
        
        const indices = {
            name: headers.indexOf('NAME'),
            zip: headers.indexOf('zip code tabulation area'),
            education: ['B15003_022E', 'B15003_023E', 'B15003_024E', 'B15003_025E']
                .map(v => headers.indexOf(v)),
            income: ['B19001_014E', 'B19001_015E', 'B19001_016E', 'B19001_017E']
                .map(v => headers.indexOf(v)),
            medianIncome: headers.indexOf('B19013_001E')
        };
        
        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            const zip = row[indices.zip];
            
            if (requestedSet.has(zip)) {
                let totalHigherEd = 0;
                let totalHighIncome = 0;
                
                for (const idx of indices.education) {
                    if (idx !== -1) {
                        const value = parseFloat(row[idx]) || 0;
                        totalHigherEd += value;
                    }
                }
                
                for (const idx of indices.income) {
                    if (idx !== -1) {
                        const value = parseFloat(row[idx]) || 0;
                        totalHighIncome += value;
                    }
                }
                
                const medianIncome = indices.medianIncome !== -1 ? 
                    parseFloat(row[indices.medianIncome]) || null : null;
                
                // FIXED: Both thresholds set to 1000
                const hasEducation = totalHigherEd >= 1000;
                const hasIncome = totalHighIncome >= 1000;
                
                // For dynamic sizing: use sqrt(value) * scale
                const educationValue = Math.max(totalHigherEd, 1000);
                const incomeValue = Math.max(totalHighIncome, 1000);
                
                results[zip] = {
                    data: {
                        Higher_Education: totalHigherEd,
                        High_Income_Households: totalHighIncome,
                        Median_Income: medianIncome
                    },
                    metadata: {
                        name: indices.name !== -1 ? row[indices.name] : 'Unknown',
                        fetchedAt: new Date().toISOString(),
                        hasEducation,
                        hasIncome,
                        educationValue,
                        incomeValue,
                        combinedValue: Math.sqrt(educationValue) * 0.5 + Math.sqrt(incomeValue) * 0.5,
                        zip: zip
                    }
                };
                
                requestedSet.delete(zip);
            }
        }
        
        return results;
    }

    async getFromCache(zip) {
        if (!this.db) return null;
        
        const cacheKey = `${this.cachePrefix}${zip}`;
        
        return new Promise((resolve) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(cacheKey);
            
            request.onsuccess = (event) => {
                const cached = event.target.result;
                if (!cached) {
                    resolve(null);
                    return;
                }
                
                // Check 24-hour TTL
                if (Date.now() > cached.expiry) {
                    store.delete(cacheKey);
                    resolve(null);
                    return;
                }
                
                resolve(cached.data);
            };
            
            request.onerror = () => resolve(null);
        });
    }

    addToMemoryCache(zip, data) {
        if (this.memoryCache.size >= this.memoryCacheSize) {
            const firstKey = this.memoryCache.keys().next().value;
            this.memoryCache.delete(firstKey);
        }
        this.memoryCache.set(zip, {
            data,
            timestamp: Date.now()
        });
    }

    async cacheData(zip, data) {
        if (!this.db) return;
        
        const cacheKey = `${this.cachePrefix}${zip}`;
        const expiry = Date.now() + this.cacheDuration; // 24 hours
        
        const cacheEntry = {
            key: cacheKey,
            data: data,
            expiry: expiry,
            cachedAt: new Date().toISOString(),
            zip: zip
        };
        
        return new Promise((resolve) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            store.put(cacheEntry);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => resolve();
        });
    }

    async cleanExpiredCache() {
        if (!this.db) return 0;
        
        const now = Date.now();
        let cleaned = 0;
        
        return new Promise((resolve) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const expiryIndex = store.index('expiry');
            const range = IDBKeyRange.upperBound(now);
            
            const request = expiryIndex.openCursor(range);
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    store.delete(cursor.primaryKey);
                    cleaned++;
                    cursor.continue();
                } else {
                    if (cleaned > 0) {
                        console.log(`Cleaned ${cleaned} expired cache entries (24-hour TTL)`);
                    }
                    resolve(cleaned);
                }
            };
            
            request.onerror = () => resolve(0);
        });
    }

    async clearCache() {
        if (!this.db) return 0;
        
        return new Promise((resolve) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.clear();
            
            request.onsuccess = () => {
                this.memoryCache.clear();
                console.log('Cache cleared');
                resolve(1);
            };
            
            request.onerror = () => resolve(0);
        });
    }

    async getCacheStats() {
        if (!this.db) return { total: 0, memory: 0 };
        
        return new Promise((resolve) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const countRequest = store.count();
            
            countRequest.onsuccess = () => {
                resolve({
                    total: countRequest.result,
                    memory: this.memoryCache.size,
                    hits: this.stats.cacheHits,
                    misses: this.stats.cacheMisses,
                    apiCalls: this.stats.apiCalls,
                    hitRate: this.stats.cacheHits + this.stats.cacheMisses > 0 ? 
                        Math.round((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100) + '%' : '0%'
                });
            };
            
            countRequest.onerror = () => resolve({ total: 0, memory: 0 });
        });
    }

    logCacheStats() {
        const totalAccess = this.stats.cacheHits + this.stats.cacheMisses;
        if (totalAccess > 0) {
            const hitRate = (this.stats.cacheHits / totalAccess * 100).toFixed(1);
            console.log(`Cache performance: ${hitRate}% hit rate (24-hour TTL)`);
        }
    }

    chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }
}

window.ACSAPIService = ACSAPIService;
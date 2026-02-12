// ============================================================================
// ZIP CODE INDEXING SERVICE - CLEANED
// ============================================================================

class ZIPCodeIndex {
    constructor() {
        this.zips = new Map();
        this.loaded = false;
    }

    async loadFromJSON(jsonUrl) {
        try {
            console.log('Loading ZIP codes...');
            
            const response = await fetch(jsonUrl);
            if (!response.ok) {
                throw new Error(`Failed to load: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (Array.isArray(data)) {
                data.forEach(record => this.addRecord(record));
            } else if (typeof data === 'object') {
                Object.entries(data).forEach(([zip, record]) => {
                    this.addRecord({ zip: zip.padStart(5, '0'), ...record });
                });
            }
            
            this.loaded = true;
            console.log(`✅ Loaded ${this.zips.size} ZIP codes`);
            
            return true;
            
        } catch (error) {
            console.error('Failed to load ZIP codes:', error);
            throw error;
        }
    }

    addRecord(record) {
        const zip = String(record.zip || record.zipcode || '').padStart(5, '0');
        
        if (zip.length === 5 && record.lat && record.lng) {
            const lat = parseFloat(record.lat);
            const lng = parseFloat(record.lng);
            
            if (!isNaN(lat) && !isNaN(lng)) {
                this.zips.set(zip, {
                    zip,
                    lat,
                    lng,
                    city: record.city || '',
                    state_id: record.state_id || record.state || '',
                    county_name: record.county_name || '',
                    population: record.population ? parseInt(record.population) : null
                });
            }
        }
    }

    get(zip) {
        return this.zips.get(zip.padStart(5, '0')) || null;
    }

    getAllStateZips(excludeTerritories = ['PR', 'GU', 'VI', 'MP', 'AS', 'UM']) {
        const stateZips = [];
        const excluded = new Set(excludeTerritories);
        
        for (const [zip, data] of this.zips) {
            if (data.state_id && !excluded.has(data.state_id)) {
                stateZips.push(zip);
            }
        }
        
        return stateZips;
    }

    getStats() {
        return {
            totalRecords: this.zips.size,
            loaded: this.loaded
        };
    }

    clear() {
        this.zips.clear();
        this.loaded = false;
    }
}

window.ZIPCodeIndex = ZIPCodeIndex;
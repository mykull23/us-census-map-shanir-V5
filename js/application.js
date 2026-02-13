// ============================================================================
// MAIN APPLICATION - Circles List replaces Hotspots
// ============================================================================

class ACSApplication {
    constructor() {
        this.zipIndex = new ZIPCodeIndex();
        this.apiService = new ACSAPIService(localStorage.getItem('census_api_key') || '40f968d5f85f0dba69d01955f65f0ecbc6ebf678');
        this.mapVisualizer = null;
        this.spatialUtils = new SpatialUtils();
        this.currentData = null;
        this.currentHotspots = [];
        
        this.activeNotifications = new Map();
        this.notificationId = 0;
        
        this.statistics = {
            educationOnly: 0,
            incomeOnly: 0,
            both: 0,
            total: 0
        };
    }

    async init() {
        try {
            console.log('Starting ACS Circle Analyzer...');
            this.updateLoadingProgress('Loading ZIP code database...', 5);

            await this.zipIndex.loadFromJSON('data/uszips.json');
            this.updateLoadingProgress(`Loaded ${this.zipIndex.zips.size.toLocaleString()} ZIP codes`, 10);

            if (typeof ACSMapVisualizer === 'undefined') {
                throw new Error('ACSMapVisualizer is not defined');
            }

            this.mapVisualizer = new ACSMapVisualizer('mapContainer', {
                enableClustering: true,
                maxClusterRadius: 40,
                clusteringMaxZoom: 5,
                topHotspotCount: 50
            });

            this.setupUI();
            this.setupMapControls();
            this.centerOnContinentalUS();

            document.getElementById('app-loading').style.display = 'none';
            document.querySelector('.app-container').style.display = 'flex';

            console.log('✅ Application initialized');
            
            setTimeout(() => this.loadData(), 100);
            
        } catch (error) {
            console.error('Initialization error:', error);
            this.showNotification(`Error: ${error.message}`, 'error');
        }
    }

    async loadData() {
        const loadingNotification = this.showNotification('Loading Census data with 90-day cache...', 'loading');
        
        try {
            const allZips = this.zipIndex.getAllStateZips();
            console.log(`Processing ${allZips.length} ZIP codes`);
            
            const cacheStats = await this.apiService.getCacheStats();
            this.updateCacheStats(cacheStats);
            
            const data = await this.apiService.fetchCombinedData(allZips);
            this.currentData = data;
            
            const processedData = this.processData(data);
            await this.mapVisualizer.visualizeCombinedData(this.zipIndex.zips, processedData);
            
            this.hideNotification(loadingNotification);
            this.showNotification(`Loaded ${Object.keys(data).length.toLocaleString()} locations`, 'success');
            
            this.updateStatisticsUI();
            
        } catch (error) {
            console.error('Failed to load data:', error);
            this.hideNotification(loadingNotification);
            this.showNotification(`Failed to load data: ${error.message}`, 'error');
        }
    }

    processData(apiData) {
        const processedData = {};
        this.statistics = { educationOnly: 0, incomeOnly: 0, both: 0, total: 0 };
        
        Object.entries(apiData).forEach(([zip, record]) => {
            if (record && record.data) {
                const hasEducation = record.metadata.hasEducation;
                const hasIncome = record.metadata.hasIncome;
                
                if (hasEducation && hasIncome) {
                    this.statistics.both++;
                } else if (hasEducation) {
                    this.statistics.educationOnly++;
                } else if (hasIncome) {
                    this.statistics.incomeOnly++;
                }
                
                if (hasEducation || hasIncome) {
                    processedData[zip] = record;
                }
            }
        });
        
        this.statistics.total = Object.keys(processedData).length;
        return processedData;
    }

    // ============================================================================
    // UI SETUP - No hotspot list creation
    // ============================================================================

    setupUI() {
        this.updateStatisticsUI();
        
        // API Key button
        document.getElementById('apiKeyBtn')?.addEventListener('click', () => {
            this.showApiKeyDialog();
        });
        
        // Reload data button
        document.getElementById('reloadDataBtn')?.addEventListener('click', () => {
            this.reloadData();
        });
        
        // Draw Circle button (kept for reference)
        document.getElementById('drawCircleBtn')?.addEventListener('click', () => {
            this.showNotification('Right-click + drag to draw circle (max 5mi), left-click to finish', 'info');
        });
        
        // Clear Circles button
        document.getElementById('clearCirclesBtn')?.addEventListener('click', () => {
            if (this.mapVisualizer) {
                this.mapVisualizer.clearAllCircles();
            }
        });
        
        // Show Hotspots button (kept for future use)
        document.getElementById('showHotspotsBtn')?.addEventListener('click', () => {
            if (this.mapVisualizer) {
                this.mapVisualizer.calculateAndShowHotspots();
            }
        });
        
        // Circle Stats button
        document.getElementById('circleStatsBtn')?.addEventListener('click', () => {
            this.showCircleStatistics();
        });
    }

    setupMapControls() {
        document.getElementById('zoomInBtn')?.addEventListener('click', () => {
            this.mapVisualizer.map.zoomIn();
        });

        document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
            this.mapVisualizer.map.zoomOut();
        });

        document.getElementById('resetViewBtn')?.addEventListener('click', () => {
            this.centerOnContinentalUS();
        });

        document.getElementById('refreshData')?.addEventListener('click', () => {
            this.reloadData();
        });
        
        document.getElementById('clearCacheBtn')?.addEventListener('click', () => {
            this.clearCache();
        });
        
        document.getElementById('fullscreenBtn')?.addEventListener('click', () => {
            this.toggleFullscreen();
        });
        
        document.getElementById('locateBtn')?.addEventListener('click', () => {
            this.locateUser();
        });
    }

    showCircleStatistics() {
        if (!this.mapVisualizer || this.mapVisualizer.circles.size === 0) {
            this.showNotification('No circles drawn. Right-click + drag on map (max 5mi), left-click to finish.', 'info');
            return;
        }
        
        let totalMarkers = 0;
        let totalEducation = 0;
        let totalHighIncome = 0;
        let totalBoth = 0;
        
        this.mapVisualizer.circles.forEach((circle) => {
            // Use donut stats for accurate counting
            if (circle.donutStats) {
                totalMarkers += circle.donutStats.inner.totalMarkers + 
                               circle.donutStats.middle.totalMarkers + 
                               circle.donutStats.outer.totalMarkers;
                totalEducation += circle.donutStats.inner.totalEducation + 
                                 circle.donutStats.middle.totalEducation + 
                                 circle.donutStats.outer.totalEducation;
                totalHighIncome += circle.donutStats.inner.totalHighIncome + 
                                  circle.donutStats.middle.totalHighIncome + 
                                  circle.donutStats.outer.totalHighIncome;
                totalBoth += circle.donutStats.inner.bothCriteria + 
                            circle.donutStats.middle.bothCriteria + 
                            circle.donutStats.outer.bothCriteria;
            }
        });
        
        const statsHTML = `
            <div style="max-width: 400px;">
                <h4 style="margin-bottom: 12px; color: #1f2937;">
                    <i class="fas fa-chart-pie" style="color: #10b981;"></i> Circle Summary
                </h4>
                <div style="background: #f0fdf4; padding: 12px; border-radius: 8px; margin-bottom: 16px;">
                    <div style="display: flex; justify-content: space-between;">
                        <span>Total Circles:</span>
                        <strong>${this.mapVisualizer.circles.size}</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-top: 8px;">
                        <span>Total ZIPs Analyzed:</span>
                        <strong>${totalMarkers.toLocaleString()}</strong>
                    </div>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                    <div style="background: #eff6ff; padding: 12px; border-radius: 8px;">
                        <div style="font-size: 20px; font-weight: bold; color: #1e40af;">${totalBoth}</div>
                        <div style="font-size: 11px;">Both Criteria</div>
                    </div>
                    <div style="background: #fef2f2; padding: 12px; border-radius: 8px;">
                        <div style="font-size: 20px; font-weight: bold; color: #991b1b;">${Math.round(totalHighIncome).toLocaleString()}</div>
                        <div style="font-size: 11px;">High-Income HH</div>
                    </div>
                    <div style="background: #eff6ff; padding: 12px; border-radius: 8px;">
                        <div style="font-size: 20px; font-weight: bold; color: #1e40af;">${Math.round(totalEducation).toLocaleString()}</div>
                        <div style="font-size: 11px;">Higher Education</div>
                    </div>
                    <div style="background: #f3e8ff; padding: 12px; border-radius: 8px;">
                        <div style="font-size: 20px; font-weight: bold; color: #6b21a8;">${totalMarkers}</div>
                        <div style="font-size: 11px;">Total ZIPs</div>
                    </div>
                </div>
            </div>
        `;
        
        this.showNotification(statsHTML, 'info', true);
    }

    updateStatisticsUI() {
        const statEducation = document.getElementById('statEducation');
        const statIncome = document.getElementById('statIncome');
        const statBoth = document.getElementById('statBoth');
        const statTotal = document.getElementById('statTotal');
        const dataStats = document.getElementById('dataStats');
        const zipCount = document.getElementById('zipCount');
        
        if (statEducation) statEducation.textContent = this.statistics.educationOnly.toLocaleString();
        if (statIncome) statIncome.textContent = this.statistics.incomeOnly.toLocaleString();
        if (statBoth) statBoth.textContent = this.statistics.both.toLocaleString();
        if (statTotal) statTotal.textContent = this.statistics.total.toLocaleString();
        if (dataStats) dataStats.textContent = `${this.statistics.total.toLocaleString()} markers`;
        if (zipCount) zipCount.textContent = this.zipIndex.zips.size.toLocaleString();
    }

    updateCacheStats(stats) {
        const cacheStatsEl = document.getElementById('cacheStats');
        if (cacheStatsEl && stats) {
            cacheStatsEl.innerHTML = `${stats.total} entries (90d)`;
        }
        
        const footerCache = document.getElementById('footerCache');
        if (footerCache) {
            footerCache.textContent = `Cache: 90 days | ${stats.total || 0} entries`;
        }
    }

    updateLoadingProgress(message, percentage) {
        const progressText = document.querySelector('.progress-text');
        const progressFill = document.querySelector('.progress-fill');
        const loadingText = document.querySelector('.loading-text');

        if (progressText) progressText.textContent = `${Math.round(percentage)}%`;
        if (progressFill) progressFill.style.width = `${percentage}%`;
        if (loadingText) loadingText.textContent = message;
        
        const zipStats = document.getElementById('zip-stats');
        if (zipStats && this.zipIndex) {
            zipStats.textContent = `ZIPs: ${this.zipIndex.zips.size.toLocaleString()}`;
        }
    }

    centerOnContinentalUS() {
        if (this.mapVisualizer) {
            this.mapVisualizer.map.setView([39.8283, -98.5795], 4);
        }
    }

    locateUser() {
        if (!navigator.geolocation) {
            this.showNotification('Geolocation not supported', 'error');
            return;
        }
        
        const notification = this.showNotification('Locating you...', 'loading');
        
        navigator.geolocation.getCurrentPosition(
            (position) => {
                this.hideNotification(notification);
                this.mapVisualizer.map.flyTo([position.coords.latitude, position.coords.longitude], 12);
                this.showNotification('Location found', 'success');
            },
            (error) => {
                this.hideNotification(notification);
                this.showNotification(`Location error: ${error.message}`, 'error');
            }
        );
    }

    toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
            document.getElementById('fullscreenBtn').innerHTML = '<i class="fas fa-compress"></i>';
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
                document.getElementById('fullscreenBtn').innerHTML = '<i class="fas fa-expand"></i>';
            }
        }
    }

    async reloadData() {
        this.currentData = null;
        this.currentHotspots = [];
        
        if (this.mapVisualizer) {
            this.mapVisualizer.clear();
        }
        
        this.showNotification('Reloading data with 90-day cache...', 'loading');
        await this.loadData();
    }

    async clearCache() {
        if (confirm('Clear all cached data? 90-day cache will reset.')) {
            const notification = this.showNotification('Clearing cache...', 'loading');
            const cleared = await this.apiService.clearCache();
            this.hideNotification(notification);
            this.showNotification(`Cache cleared. ${cleared ? 'Success' : 'Failed'}`, 'info');
            this.reloadData();
        }
    }

    showApiKeyDialog() {
        const currentKey = localStorage.getItem('census_api_key') || '40f968d5f85f0dba69d01955f65f0ecbc6ebf678';
        const newKey = prompt('Enter your Census API key:', currentKey);
        
        if (newKey && newKey.trim()) {
            localStorage.setItem('census_api_key', newKey.trim());
            this.apiService.apiKey = newKey.trim();
            this.showNotification('API key updated. Reload data to apply.', 'success');
        }
    }

    showNotification(message, type = 'info', isHTML = false) {
        const id = this.notificationId++;
        const container = document.querySelector('.notification-container');
        
        if (!container) return null;
        
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.dataset.notificationId = id;
        
        const icon = type === 'success' ? 'fa-check-circle' :
                    type === 'error' ? 'fa-exclamation-circle' :
                    type === 'warning' ? 'fa-exclamation-triangle' :
                    type === 'loading' ? 'fa-spinner fa-pulse' :
                    'fa-info-circle';
        
        notification.innerHTML = `
            <div class="notification-content">
                <div class="notification-icon">
                    <i class="fas ${icon}"></i>
                </div>
                <div class="notification-body">
                    <div class="notification-message">${isHTML ? message : this.escapeHtml(message)}</div>
                </div>
                <button class="notification-close">&times;</button>
            </div>
        `;

        container.appendChild(notification);
        
        notification.querySelector('.notification-close').addEventListener('click', () => {
            this.hideNotification(id);
        });
        
        this.activeNotifications.set(id, notification);
        
        if (type !== 'loading') {
            setTimeout(() => {
                this.hideNotification(id);
            }, 6000);
        }
        
        return id;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    hideNotification(id) {
        if (id === undefined) {
            this.activeNotifications.forEach((notification, notificationId) => {
                if (notification.classList.contains('notification-loading')) {
                    notification.style.animation = 'slideOut 0.3s ease-out forwards';
                    setTimeout(() => {
                        notification.remove();
                        this.activeNotifications.delete(notificationId);
                    }, 300);
                }
            });
            return;
        }
        
        const notification = this.activeNotifications.get(id);
        if (notification) {
            notification.style.animation = 'slideOut 0.3s ease-out forwards';
            setTimeout(() => {
                notification.remove();
                this.activeNotifications.delete(id);
            }, 300);
        }
    }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    window.acsApp = new ACSApplication();
    window.acsApp.init();
});
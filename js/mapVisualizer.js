// ============================================================================
// MAP VISUALIZATION ENGINE - WITH RINGS ANALYSIS (HOTSPOTS PRESERVED)
// ============================================================================

class ACSMapVisualizer {
    constructor(containerId, options = {}) {
        this.config = {
            containerId,
            minZoom: 3,
            maxZoom: 18,
            defaultZoom: 4,
            defaultCenter: [39.8283, -98.5795],
            tileLayer: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            attribution: '© OpenStreetMap contributors, © CARTO',
            enableClustering: true,
            maxClusterRadius: 40,
            clusteringMinZoom: 0,
            clusteringMaxZoom: 6,
            topHotspotCount: 50,
            ...options
        };

        this.map = null;
        this.markerCluster = null;
        this.markers = new Map();
        
        // HOTSPOTS - PRESERVED FOR FUTURE USE
        this.hotspots = [];
        this.hotspotLayers = [];
        this.isCalculatingHotspots = false;
        this.hotspotNotificationId = null;
        
        this.activePopup = null;
        
        // Marker navigation
        this.markerList = [];
        this.currentMarkerIndex = -1;
        this.lastNavigationTime = 0;
        this.navigationCooldown = 300;
        
        // Layer visibility states
        this.layerVisibility = {
            education: true,
            income: true,
            both: true,
            rings: true
        };
        
        // Spatial utilities
        this.spatialUtils = new SpatialUtils();
        
        // RINGS state
        this.isDrawing = false;
        this.tempCircle = null;
        this.startPoint = null;
        this.rings = new Map();
        this.ringCounter = 0;
        this.ringCreationOrder = [];
        
        // Prevent multiple drawing sessions
        this.drawingLock = false;
        
        // Active ring popup state
        this.activeRingId = null;
        this.activeRingType = 'weighted';
        
        // Storage keys
        this.storageKey = 'acs_map_rings_v1';
        this.layerStorageKey = 'acs_map_layers_v1';
        
        // Drawing limits
        this.MAX_RADIUS_MILES = 5;
        this.MILES_TO_METERS = 1609.34;
        this.MAX_RADIUS_METERS = this.MAX_RADIUS_MILES * this.MILES_TO_METERS;
        
        this.layerColors = {
            education: '#3b82f6',
            income: '#ef4444',
            both: '#8b5cf6',
            hotspot: '#ef4444',
            hotspotFill: 'rgba(239, 68, 68, 0.15)',
            ring: {
                inner: '#10b981',
                middle: '#f59e0b',
                outer: '#ef4444'
            },
            maxLimit: '#00ffff' // Neon blue for max limit
        };

        this.initMap();
        this.setupRingDrawing();
        this.setupKeyboardNavigation();
        this.setupCoordinatesDisplay();
        this.setupLayerToggleListeners();
        
        // Ring list manager
        this.ringListManager = null;
        
        // Load saved layer visibility
        this.loadLayerVisibility();
        
        // Load saved rings after map is initialized
        setTimeout(() => {
            this.loadSavedRings();
            this.initRingListManager();
        }, 1000);
    }

    // ============================================================================
    // MAP INITIALIZATION
    // ============================================================================

    initMap() {
        const container = document.getElementById(this.config.containerId);
        if (!container) {
            throw new Error(`Map container not found: ${this.config.containerId}`);
        }

        this.map = L.map(container, {
            center: this.config.defaultCenter,
            zoom: this.config.defaultZoom,
            minZoom: this.config.minZoom,
            maxZoom: this.config.maxZoom,
            zoomControl: false,
            preferCanvas: true
        });

        L.tileLayer(this.config.tileLayer, {
            attribution: this.config.attribution,
            maxZoom: 19,
            crossOrigin: true
        }).addTo(this.map);

        this.map.on('click', () => {
            this.closeAllPopups();
        });

        if (this.config.enableClustering) {
            this.markerCluster = L.markerClusterGroup({
                maxClusterRadius: this.config.maxClusterRadius,
                disableClusteringAtZoom: this.config.clusteringMaxZoom,
                iconCreateFunction: this.createClusterIcon.bind(this),
                spiderfyOnMaxZoom: true,
                showCoverageOnHover: false,
                zoomToBoundsOnClick: true
            });
            
            this.map.addLayer(this.markerCluster);
        }

        L.control.scale({ imperial: true, metric: false, position: 'bottomleft' }).addTo(this.map);
    }

    // ============================================================================
    // RING LIST MANAGER
    // ============================================================================

    initRingListManager() {
        const container = document.getElementById('circles-list-container');
        const scrollEl = document.getElementById('circles-list-scroll');
        
        if (!container || !scrollEl) return;
        
        this.ringListManager = {
            container,
            scrollEl,
            updateList: () => {
                if (!scrollEl) return;
                
                const rings = Array.from(this.rings.entries());
                if (rings.length === 0) {
                    scrollEl.innerHTML = `
                        <div style="padding: 48px 24px; text-align: center; color: #6b7280;">
                            <i class="fas fa-draw-circle" style="font-size: 48px; color: #d1d5db;"></i>
                            <div style="margin-top: 16px;">No analysis rings drawn</div>
                            <div style="margin-top: 8px; font-size: 12px;">Right-click + drag to draw (max 5 miles)</div>
                        </div>
                    `;
                    document.querySelector('.circles-count-badge').textContent = '0 rings';
                    return;
                }
                
                // Sort oldest first
                rings.sort((a, b) => a[1].created - b[1].created);
                
                let html = '';
                rings.forEach(([ringId, ring], index) => {
                    const location = this.getPrimaryLocation(ring);
                    html += `
                        <div class="circle-group" data-ring-id="${ringId}" style="border-bottom: 1px solid #e5e7eb; padding: 12px; cursor: pointer;" onclick="window.acsApp?.mapVisualizer.flyToRing('${ringId}')">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <span style="font-weight: 600; color: #10b981; margin-right: 8px;">${index + 1}.</span>
                                    <span style="font-weight: 500; color: #1f2937;">${location}</span>
                                </div>
                                <div style="font-size: 11px; color: #6b7280;">
                                    ${new Date(ring.timestamp).toLocaleTimeString()}
                                </div>
                            </div>
                            <div style="display: flex; gap: 12px; margin-top: 8px; font-size: 12px;">
                                <span><span style="color: #10b981;">●</span> ${ring.donutStats.inner.totalMarkers} ZIPs</span>
                                <span><span style="color: #f59e0b;">●</span> ${ring.donutStats.middle.totalMarkers} ZIPs</span>
                                <span><span style="color: #ef4444;">●</span> ${ring.donutStats.outer.totalMarkers} ZIPs</span>
                            </div>
                        </div>
                    `;
                });
                
                scrollEl.innerHTML = html;
                const badge = document.querySelector('.circles-count-badge');
                if (badge) badge.textContent = `${rings.length} ring${rings.length !== 1 ? 's' : ''}`;
            }
        };
    }

    getPrimaryLocation(ring) {
        const locations = ring.locations?.inner;
        if (locations?.counties?.length > 0) {
            return locations.counties[0] + (locations.states?.[0] ? `, ${locations.states[0]}` : '');
        }
        if (locations?.cities?.length > 0) {
            return locations.cities[0] + (locations.states?.[0] ? `, ${locations.states[0]}` : '');
        }
        return `Rings at ${ring.center.lat.toFixed(4)}, ${ring.center.lng.toFixed(4)}`;
    }

    flyToRing(ringId) {
        const ring = this.rings.get(ringId);
        if (ring) {
            this.map.flyTo(ring.center, 10, { duration: 1.0 });
            setTimeout(() => {
                this.closeAllPopups();
                this.showRingPopup(ringId, 'weighted');
            }, 1000);
        }
    }

    // ============================================================================
    // RING DRAWING - WITH 5 MILE HARD LIMIT
    // ============================================================================

    setupRingDrawing() {
        this.map.getContainer().addEventListener('contextmenu', (e) => {
            e.preventDefault();
            return false;
        });

        this.map.on('contextmenu', (e) => {
            e.originalEvent.preventDefault();
            
            if (this.drawingLock || this.isDrawing) {
                return false;
            }
            
            this.startDrawing(e.latlng);
            return false;
        });

        this.map.on('mousemove', (e) => {
            if (this.isDrawing && this.tempCircle && this.startPoint) {
                const rawDistance = this.startPoint.distanceTo(e.latlng);
                // Cap at 5 miles maximum
                const radius = Math.min(rawDistance, this.MAX_RADIUS_METERS);
                this.tempCircle.setRadius(radius);
                
                // Visual feedback when hitting the limit - NEON BLUE
                if (radius >= this.MAX_RADIUS_METERS - 100) {
                    this.tempCircle.setStyle({
                        color: '#00ffff',
                        fillColor: '#00ffff',
                        weight: 4,
                        fillOpacity: 0.2
                    });
                } else {
                    this.tempCircle.setStyle({
                        color: this.layerColors.ring.inner,
                        fillColor: this.layerColors.ring.inner,
                        dashArray: '5, 5',
                        weight: 3
                    });
                }
            }
        });

        this.map.on('click', (e) => {
            if (this.isDrawing && this.tempCircle && this.startPoint) {
                const rawDistance = this.startPoint.distanceTo(e.latlng);
                const radius = Math.min(rawDistance, this.MAX_RADIUS_METERS);
                
                if (radius > 100) {
                    this.finishDrawing(radius);
                } else {
                    this.cancelDrawing();
                    this.showNotification('Ring too small, try again', 'warning');
                }
                e.originalEvent.preventDefault();
            }
        });
    }

    startDrawing(startLatLng) {
        if (this.drawingLock || this.isDrawing) {
            return;
        }
        
        this.drawingLock = true;
        this.isDrawing = true;
        this.startPoint = startLatLng;
        
        if (this.tempCircle) {
            this.map.removeLayer(this.tempCircle);
        }
        
        this.tempCircle = L.circle(startLatLng, {
            radius: 0,
            color: this.layerColors.ring.inner,
            weight: 3,
            fillColor: this.layerColors.ring.inner,
            fillOpacity: 0.15,
            dashArray: '5, 5',
            className: 'temp-circle'
        }).addTo(this.map);
        
        this.map.getContainer().style.cursor = 'crosshair';
        
        this.showNotification('Draw center point (max 5 miles) - Creates 5mi/10mi/25mi rings', 'info');
    }

    finishDrawing(baseRadiusMeters) {
        if (!this.isDrawing || !this.tempCircle || !this.startPoint) {
            this.cancelDrawing();
            return;
        }
        
        const ringId = `ring_${Date.now()}_${this.ringCounter++}`;
        const center = this.startPoint;
        
        // FIXED RADII: 5, 10, 25 miles
        const innerRadiusMiles = 5;
        const middleRadiusMiles = 10;
        const outerRadiusMiles = 25;
        
        const milesToMeters = 1609.34;
        const innerRadiusMeters = innerRadiusMiles * milesToMeters;
        const middleRadiusMeters = middleRadiusMiles * milesToMeters;
        const outerRadiusMeters = outerRadiusMiles * milesToMeters;
        
        // Create INNER ring (Green) - 5 miles
        const innerRing = L.circle(center, {
            radius: innerRadiusMeters,
            color: this.layerColors.ring.inner,
            weight: 3,
            fillColor: this.layerColors.ring.inner,
            fillOpacity: 0.15,
            className: 'drawn-circle inner-circle',
            interactive: true
        }).addTo(this.map);
        
        // Create MIDDLE ring (Orange) - 10 miles
        const middleRing = L.circle(center, {
            radius: middleRadiusMeters,
            color: this.layerColors.ring.middle,
            weight: 2.5,
            fillColor: this.layerColors.ring.middle,
            fillOpacity: 0.1,
            className: 'drawn-circle middle-circle',
            interactive: true
        }).addTo(this.map);
        
        // Create OUTER ring (Red) - 25 miles
        const outerRing = L.circle(center, {
            radius: outerRadiusMeters,
            color: this.layerColors.ring.outer,
            weight: 2,
            fillColor: this.layerColors.ring.outer,
            fillOpacity: 0.05,
            className: 'drawn-circle outer-circle',
            interactive: true
        }).addTo(this.map);
        
        // Calculate DONUT STATS (non-cumulative)
        const innerDonutStats = this.calculateDonutStats(center, 0, innerRadiusMeters);
        const middleDonutStats = this.calculateDonutStats(center, innerRadiusMeters, middleRadiusMeters);
        const outerDonutStats = this.calculateDonutStats(center, middleRadiusMeters, outerRadiusMeters);
        
        // Calculate WEIGHTED DONUT STATS (radius multiplied, non-cumulative)
        // INNER: 5mi ×3 = 15mi total (0-15)
        const weightedInnerDonutStats = this.calculateDonutStats(center, 0, innerRadiusMiles * 3 * milesToMeters);
        
        // MIDDLE: 10mi ×2 = 20mi total, but starting at 15 (where inner weighted ends)
        const weightedMiddleDonutStats = this.calculateDonutStats(center, innerRadiusMiles * 3 * milesToMeters, middleRadiusMiles * 2 * milesToMeters);
        
        // OUTER: ×1 means SAME AS REGULAR OUTER (10-25 miles)
        const weightedOuterDonutStats = this.calculateDonutStats(center, middleRadiusMiles * milesToMeters, outerRadiusMiles * milesToMeters);
        
        // Get locations for each donut
        const innerLocations = this.getLocationsInCircle(center, innerRadiusMeters);
        const middleLocations = this.getLocationsInDonut(center, innerRadiusMeters, middleRadiusMeters);
        const outerLocations = this.getLocationsInDonut(center, middleRadiusMeters, outerRadiusMeters);
        
        // Store ring data
        const ringData = {
            id: ringId,
            center: center,
            layers: [innerRing, middleRing, outerRing],
            radii: {
                inner: innerRadiusMiles,
                middle: middleRadiusMiles,
                outer: outerRadiusMiles,
                innerMeters: innerRadiusMeters,
                middleMeters: middleRadiusMeters,
                outerMeters: outerRadiusMeters
            },
            // DONUT STATS (non-cumulative)
            donutStats: {
                inner: innerDonutStats,
                middle: middleDonutStats,
                outer: outerDonutStats
            },
            // WEIGHTED DONUT STATS (radius multiplied, non-cumulative)
            weightedStats: {
                inner: weightedInnerDonutStats,
                middle: weightedMiddleDonutStats,
                outer: weightedOuterDonutStats
            },
            locations: {
                inner: innerLocations,
                middle: middleLocations,
                outer: outerLocations
            },
            created: Date.now(),
            timestamp: new Date().toISOString()
        };
        
        this.rings.set(ringId, ringData);
        this.ringCreationOrder.push(ringId);
        
        // Add click handlers
        innerRing.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.activeRingId = ringId;
            this.activeRingType = 'inner';
            this.showRingPopup(ringId, 'inner');
        });
        
        middleRing.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.activeRingId = ringId;
            this.activeRingType = 'middle';
            this.showRingPopup(ringId, 'middle');
        });
        
        outerRing.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.activeRingId = ringId;
            this.activeRingType = 'outer';
            this.showRingPopup(ringId, 'outer');
        });
        
        // Right-click removes all three rings
        [innerRing, middleRing, outerRing].forEach(ring => {
            ring.on('contextmenu', (e) => {
                L.DomEvent.stopPropagation(e);
                e.originalEvent.preventDefault();
                this.removeRing(ringId);
                return false;
            });
        });
        
        // Show weighted tab by default
        this.activeRingId = ringId;
        this.activeRingType = 'weighted';
        this.closeAllPopups();
        this.showRingPopup(ringId, 'weighted');
        
        // Save rings to localStorage
        this.saveRings();
        
        // Update rings list
        if (this.ringListManager) this.ringListManager.updateList();
        
        this.showNotification(
            `Analysis rings created: 5mi / 10mi / 25mi (donut analysis)`, 
            'success'
        );
        
        this.cancelDrawing();
    }

    // ============================================================================
    // DONUT CALCULATIONS
    // ============================================================================

    calculateDonutStats(center, minMeters, maxMeters) {
        let stats = { 
            totalMarkers: 0, 
            educationOnly: 0, 
            incomeOnly: 0, 
            bothCriteria: 0, 
            totalEducation: 0, 
            totalHighIncome: 0, 
            medianIncomes: [] 
        };
        
        this.markers.forEach(marker => {
            if (!marker.data) return;
            
            const distance = this.spatialUtils.haversineDistance(
                { lat: center.lat, lng: center.lng },
                { lat: marker.getLatLng().lat, lng: marker.getLatLng().lng }
            );
            
            if (distance > minMeters && distance <= maxMeters) {
                stats.totalMarkers++;
                
                if (marker.data.hasEducation && marker.data.hasIncome) {
                    stats.bothCriteria++;
                } else if (marker.data.hasEducation) {
                    stats.educationOnly++;
                } else if (marker.data.hasIncome) {
                    stats.incomeOnly++;
                }
                
                stats.totalEducation += marker.data.totalHigherEd || 0;
                stats.totalHighIncome += marker.data.totalHighIncomeHouseholds || 0;
                
                if (marker.data.medianIncome) {
                    stats.medianIncomes.push(marker.data.medianIncome);
                }
            }
        });
        
        // Calculate median income
        if (stats.medianIncomes.length > 0) {
            stats.medianIncomes.sort((a, b) => a - b);
            const mid = Math.floor(stats.medianIncomes.length / 2);
            stats.medianIncome = stats.medianIncomes.length % 2 === 0
                ? (stats.medianIncomes[mid - 1] + stats.medianIncomes[mid]) / 2
                : stats.medianIncomes[mid];
        }
        
        return stats;
    }

    getLocationsInCircle(center, radiusMeters) {
        const counties = new Set();
        const cities = new Set();
        const states = new Set();
        
        this.markers.forEach((marker) => {
            const distance = this.spatialUtils.haversineDistance(
                { lat: center.lat, lng: center.lng },
                { lat: marker.getLatLng().lat, lng: marker.getLatLng().lng }
            );
            
            if (distance <= radiusMeters && marker.data) {
                if (marker.data.county) counties.add(marker.data.county);
                if (marker.data.city) cities.add(marker.data.city);
                if (marker.data.state) states.add(marker.data.state);
            }
        });
        
        return {
            counties: Array.from(counties).sort().slice(0, 8),
            cities: Array.from(cities).sort().slice(0, 8),
            states: Array.from(states).sort(),
            countyCount: counties.size,
            cityCount: cities.size
        };
    }

    getLocationsInDonut(center, minMeters, maxMeters) {
        const counties = new Set();
        const cities = new Set();
        const states = new Set();
        
        this.markers.forEach((marker) => {
            const distance = this.spatialUtils.haversineDistance(
                { lat: center.lat, lng: center.lng },
                { lat: marker.getLatLng().lat, lng: marker.getLatLng().lng }
            );
            
            if (distance > minMeters && distance <= maxMeters && marker.data) {
                if (marker.data.county) counties.add(marker.data.county);
                if (marker.data.city) cities.add(marker.data.city);
                if (marker.data.state) states.add(marker.data.state);
            }
        });
        
        return {
            counties: Array.from(counties).sort().slice(0, 8),
            cities: Array.from(cities).sort().slice(0, 8),
            states: Array.from(states).sort(),
            countyCount: counties.size,
            cityCount: cities.size
        };
    }

    // ============================================================================
    // TABBED RING POPUP WITH WEIGHTED TAB
    // ============================================================================

    showRingPopup(ringId, tabId = 'weighted') {
        const ring = this.rings.get(ringId);
        if (!ring) return;
        
        const center = ring.center;
        
        // Create popup container
        const popupContent = document.createElement('div');
        popupContent.style.cssText = 'padding: 0; min-width: 360px; max-width: 400px; background: white; border-radius: 12px; overflow: hidden; color: #1f2937;';
        
        // Tab headers - SINGLE icon each
        const tabHeaders = document.createElement('div');
        tabHeaders.style.cssText = 'display: flex; border-bottom: 1px solid #e5e7eb; background: #f9fafb;';
        
        const tabs = [
            { id: 'weighted', label: 'Weighted', icon: 'fa-chart-line', color: '#10b981' },
            { id: 'inner', label: 'Inner', icon: 'fa-circle', color: '#10b981' },
            { id: 'middle', label: 'Middle', icon: 'fa-circle', color: '#f59e0b' },
            { id: 'outer', label: 'Outer', icon: 'fa-circle', color: '#ef4444' }
        ];
        
        tabs.forEach(tab => {
            const tabEl = document.createElement('div');
            tabEl.style.cssText = `
                flex: 1;
                padding: 12px 4px;
                text-align: center;
                cursor: pointer;
                font-size: 12px;
                font-weight: ${tab.id === tabId ? '600' : '400'};
                color: ${tab.id === tabId ? tab.color : '#6b7280'};
                border-bottom: ${tab.id === tabId ? '2px solid ' + tab.color : '2px solid transparent'};
                transition: all 0.2s;
            `;
            tabEl.innerHTML = `<i class="fas ${tab.icon}" style="margin-right: 4px;"></i> ${tab.label}`;
            tabEl.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.closeAllPopups();
                this.showRingPopup(ringId, tab.id);
            };
            tabHeaders.appendChild(tabEl);
        });
        
        popupContent.appendChild(tabHeaders);
        
        // Content container
        const contentDiv = document.createElement('div');
        contentDiv.style.cssText = 'padding: 16px; max-height: 400px; overflow-y: auto; color: #1f2937;';
        
        // Generate content based on selected tab
        if (tabId === 'weighted') {
            contentDiv.innerHTML = this.getWeightedContent(ring);
        } else {
            contentDiv.innerHTML = this.getDonutContent(ring, tabId);
        }
        
        popupContent.appendChild(contentDiv);
        
        // Footer
        const footer = document.createElement('div');
        footer.style.cssText = 'padding: 12px 16px; background: #f9fafb; border-top: 1px solid #e5e7eb; font-size: 11px; color: #4b5563; display: flex; justify-content: space-between;';
        footer.innerHTML = `
            <span><i class="fas fa-info-circle"></i> Right-click ring to delete</span>
            <span>${new Date(ring.timestamp).toLocaleTimeString()}</span>
        `;
        popupContent.appendChild(footer);
        
        // Open popup
        this.activePopup = L.popup({
            maxWidth: 450,
            className: 'ring-popup',
            autoClose: false,
            closeButton: true
        })
        .setLatLng(center)
        .setContent(popupContent)
        .openOn(this.map);
    }

    getDonutContent(ring, ringType) {
        const stats = ring.donutStats[ringType];
        const locations = ring.locations[ringType];
        const radius = ring.radii[ringType];
        
        const config = {
            inner: { color: '#10b981', bg: '#f0fdf4', label: 'Inner Donut (0-5mi)' },
            middle: { color: '#f59e0b', bg: '#fff7ed', label: 'Middle Donut (5-10mi)' },
            outer: { color: '#ef4444', bg: '#fef2f2', label: 'Outer Donut (10-25mi)' }
        };
        
        const cfg = config[ringType];
        
        return `
            <div>
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px;">
                    <div style="background: ${cfg.color}; width: 12px; height: 12px; border-radius: 50%;"></div>
                    <div>
                        <div style="font-weight: 600; color: #1f2937;">${cfg.label}</div>
                        <div style="font-size: 11px; color: #4b5563;">${radius} miles · Donut only</div>
                    </div>
                </div>
                
                <div style="background: ${cfg.bg}; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                        <div style="text-align: center;">
                            <div style="font-size: 20px; font-weight: 700; color: #1e40af;">${stats.educationOnly}</div>
                            <div style="font-size: 11px; color: #4b5563;">Edu Only</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 20px; font-weight: 700; color: #991b1b;">${stats.incomeOnly}</div>
                            <div style="font-size: 11px; color: #4b5563;">Inc Only</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 20px; font-weight: 700; color: #6b21a8;">${stats.bothCriteria}</div>
                            <div style="font-size: 11px; color: #4b5563;">Both ⭐</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 20px; font-weight: 700; color: #1f2937;">${stats.totalMarkers}</div>
                            <div style="font-size: 11px; color: #4b5563;">Total ZIPs</div>
                        </div>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding-top: 12px; border-top: 1px solid #e5e7eb;">
                        <div>
                            <div style="font-size: 11px; color: #4b5563;">Total Education ≥ Bachelor's</div>
                            <div style="font-size: 18px; font-weight: 700; color: #1e40af;">${Math.round(stats.totalEducation).toLocaleString()}</div>
                        </div>
                        <div>
                            <div style="font-size: 11px; color: #4b5563;">Total Households ≥ $100k</div>
                            <div style="font-size: 18px; font-weight: 700; color: #991b1b;">${Math.round(stats.totalHighIncome).toLocaleString()}</div>
                        </div>
                    </div>
                </div>
                
                <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                    <div style="font-weight: 600; margin-bottom: 12px;">Economic Profile</div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                        <span style="color: #4b5563;">Median Income:</span>
                        <span style="font-weight: 600;">$${stats.medianIncome ? Math.round(stats.medianIncome).toLocaleString() : 'N/A'}</span>
                    </div>
                </div>
                
                ${locations.counties && locations.counties.length ? `
                <div style="background: #f9fafb; border-radius: 8px; padding: 16px;">
                    <div style="font-weight: 600; margin-bottom: 8px;">Counties (${locations.countyCount})</div>
                    <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                        ${locations.counties.map(c => `<span style="background: #e5e7eb; padding: 4px 8px; border-radius: 12px; font-size: 11px; color: #1f2937;">${c}</span>`).join('')}
                    </div>
                </div>
                ` : ''}
            </div>
        `;
    }

    getWeightedContent(ring) {
        const ws = ring.weightedStats;
        const regularStats = ring.donutStats;
        
        // Calculate donut ranges
        const ranges = {
            inner: { min: 0, max: 15 },      // 5mi ×3 = 15mi
            middle: { min: 15, max: 20 },     // 10mi ×2 = 20mi (starting at 15)
            outer: { min: 10, max: 25 }       // 25mi ×1 = 25mi (SAME AS REGULAR OUTER)
        };
        
        return `
            <div>
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px;">
                    <div style="background: #10b981; width: 12px; height: 12px; border-radius: 50%;"></div>
                    <div>
                        <div style="font-weight: 600; color: #1f2937;">Radius-Weighted Donuts</div>
                        <div style="font-size: 11px; color: #4b5563;">Inner ×3 (0-15mi) · Middle ×2 (15-20mi) · Outer ×1 (10-25mi)</div>
                    </div>
                </div>
                
                <!-- Inner Weighted Donut (0-15 miles) -->
                <div style="background: #f0fdf4; border-radius: 8px; padding: 12px; margin-bottom: 12px; border-left: 4px solid #10b981;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <div>
                            <span style="font-weight: 600; color: #065f46;">Inner Weighted</span>
                            <span style="font-size: 11px; color: #4b5563; margin-left: 6px;">${ranges.inner.min}-${ranges.inner.max} miles</span>
                        </div>
                        <span style="font-size: 12px; background: #10b981; color: white; padding: 2px 8px; border-radius: 12px;">${ws.inner.totalMarkers} ZIPs</span>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 8px;">
                        <div>
                            <div style="font-size: 11px; color: #4b5563;">Education ≥ Bachelor's</div>
                            <div style="font-size: 20px; font-weight: 700; color: #1e40af;">${Math.round(ws.inner.totalEducation).toLocaleString()}</div>
                        </div>
                        <div>
                            <div style="font-size: 11px; color: #4b5563;">Households ≥ $100k</div>
                            <div style="font-size: 20px; font-weight: 700; color: #991b1b;">${Math.round(ws.inner.totalHighIncome).toLocaleString()}</div>
                        </div>
                    </div>
                    
                    <div style="display: flex; gap: 16px; font-size: 12px; color: #4b5563; padding-top: 8px; border-top: 1px solid #e5e7eb;">
                        <span><span style="color: #1e40af;">📚</span> Edu Only: ${ws.inner.educationOnly}</span>
                        <span><span style="color: #991b1b;">💰</span> Inc Only: ${ws.inner.incomeOnly}</span>
                        <span><span style="color: #5b21b6;">⭐</span> Both: ${ws.inner.bothCriteria}</span>
                    </div>
                </div>
                
                <!-- Middle Weighted Donut (15-20 miles) -->
                <div style="background: #fff7ed; border-radius: 8px; padding: 12px; margin-bottom: 12px; border-left: 4px solid #f59e0b;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <div>
                            <span style="font-weight: 600; color: #92400e;">Middle Weighted</span>
                            <span style="font-size: 11px; color: #4b5563; margin-left: 6px;">${ranges.middle.min}-${ranges.middle.max} miles</span>
                        </div>
                        <span style="font-size: 12px; background: #f59e0b; color: white; padding: 2px 8px; border-radius: 12px;">${ws.middle.totalMarkers} ZIPs</span>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 8px;">
                        <div>
                            <div style="font-size: 11px; color: #4b5563;">Education ≥ Bachelor's</div>
                            <div style="font-size: 20px; font-weight: 700; color: #1e40af;">${Math.round(ws.middle.totalEducation).toLocaleString()}</div>
                        </div>
                        <div>
                            <div style="font-size: 11px; color: #4b5563;">Households ≥ $100k</div>
                            <div style="font-size: 20px; font-weight: 700; color: #991b1b;">${Math.round(ws.middle.totalHighIncome).toLocaleString()}</div>
                        </div>
                    </div>
                    
                    <div style="display: flex; gap: 16px; font-size: 12px; color: #4b5563; padding-top: 8px; border-top: 1px solid #e5e7eb;">
                        <span><span style="color: #1e40af;">📚</span> Edu Only: ${ws.middle.educationOnly}</span>
                        <span><span style="color: #991b1b;">💰</span> Inc Only: ${ws.middle.incomeOnly}</span>
                        <span><span style="color: #5b21b6;">⭐</span> Both: ${ws.middle.bothCriteria}</span>
                    </div>
                </div>
                
                <!-- Outer Weighted Donut (10-25 miles) - SAME AS REGULAR OUTER -->
                <div style="background: #fef2f2; border-radius: 8px; padding: 12px; margin-bottom: 12px; border-left: 4px solid #ef4444;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <div>
                            <span style="font-weight: 600; color: #991b1b;">Outer Weighted</span>
                            <span style="font-size: 11px; color: #4b5563; margin-left: 6px;">${ranges.outer.min}-${ranges.outer.max} miles</span>
                        </div>
                        <span style="font-size: 12px; background: #ef4444; color: white; padding: 2px 8px; border-radius: 12px;">${ws.outer.totalMarkers} ZIPs</span>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 8px;">
                        <div>
                            <div style="font-size: 11px; color: #4b5563;">Education ≥ Bachelor's</div>
                            <div style="font-size: 20px; font-weight: 700; color: #1e40af;">${Math.round(ws.outer.totalEducation).toLocaleString()}</div>
                        </div>
                        <div>
                            <div style="font-size: 11px; color: #4b5563;">Households ≥ $100k</div>
                            <div style="font-size: 20px; font-weight: 700; color: #991b1b;">${Math.round(ws.outer.totalHighIncome).toLocaleString()}</div>
                        </div>
                    </div>
                    
                    <div style="display: flex; gap: 16px; font-size: 12px; color: #4b5563; padding-top: 8px; border-top: 1px solid #e5e7eb;">
                        <span><span style="color: #1e40af;">📚</span> Edu Only: ${ws.outer.educationOnly}</span>
                        <span><span style="color: #991b1b;">💰</span> Inc Only: ${ws.outer.incomeOnly}</span>
                        <span><span style="color: #5b21b6;">⭐</span> Both: ${ws.outer.bothCriteria}</span>
                    </div>
                </div>
                
                <!-- Comparison with Regular Donuts -->
                <div style="margin-top: 16px; background: #f3f4f6; border-radius: 8px; padding: 12px; font-size: 12px;">
                    <div style="font-weight: 600; margin-bottom: 8px; color: #374151;">📊 Regular vs Weighted Donuts</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                        <div>
                            <div style="color: #10b981;">Inner (0-5mi)</div>
                            <div>${regularStats.inner.totalMarkers} ZIPs</div>
                        </div>
                        <div>
                            <div style="color: #10b981;">Inner W (0-15mi)</div>
                            <div>${ws.inner.totalMarkers} ZIPs</div>
                        </div>
                        <div>
                            <div style="color: #f59e0b;">Middle (5-10mi)</div>
                            <div>${regularStats.middle.totalMarkers} ZIPs</div>
                        </div>
                        <div>
                            <div style="color: #f59e0b;">Middle W (15-20mi)</div>
                            <div>${ws.middle.totalMarkers} ZIPs</div>
                        </div>
                        <div>
                            <div style="color: #ef4444;">Outer (10-25mi)</div>
                            <div>${regularStats.outer.totalMarkers} ZIPs</div>
                        </div>
                        <div>
                            <div style="color: #ef4444;">Outer W (10-25mi)</div>
                            <div>${ws.outer.totalMarkers} ZIPs</div>
                        </div>
                    </div>
                    <div style="margin-top: 8px; font-size: 11px; color: #059669; text-align: center;">
                        ✓ Outer weighted (×1) matches regular outer exactly
                    </div>
                </div>
                
                <div style="margin-top: 12px; font-size: 12px; color: #4b5563; background: #e0f2fe; padding: 8px; border-radius: 6px;">
                    <i class="fas fa-info-circle"></i> <strong>⭐ Star = Both criteria met</strong> (Education ≥ Bachelor's AND Household Income ≥ $100k)
                </div>
            </div>
        `;
    }

    // ============================================================================
    // PERSISTENT RING STORAGE
    // ============================================================================

    saveRings() {
        try {
            const ringsData = [];
            this.rings.forEach((ring, id) => {
                ringsData.push({
                    id: id,
                    center: {
                        lat: ring.center.lat,
                        lng: ring.center.lng
                    },
                    radii: ring.radii,
                    donutStats: ring.donutStats,
                    weightedStats: ring.weightedStats,
                    locations: ring.locations,
                    timestamp: ring.timestamp,
                    created: ring.created
                });
            });
            
            localStorage.setItem(this.storageKey, JSON.stringify(ringsData));
        } catch (e) {
            console.error('Failed to save rings:', e);
        }
    }

    loadSavedRings() {
        try {
            const saved = localStorage.getItem(this.storageKey);
            if (!saved) return;
            
            const ringsData = JSON.parse(saved);
            if (!Array.isArray(ringsData)) return;
            
            // Clear any existing rings first
            this.rings.forEach((ring) => {
                ring.layers.forEach(layer => {
                    if (this.map && this.map.hasLayer(layer)) {
                        this.map.removeLayer(layer);
                    }
                });
            });
            this.rings.clear();
            this.ringCreationOrder = [];
            
            // Load saved rings
            ringsData.forEach(ringData => {
                this.recreateRing(ringData);
            });
            
            if (ringsData.length > 0) {
                this.showNotification(`Loaded ${ringsData.length} saved rings`, 'info');
                if (this.ringListManager) this.ringListManager.updateList();
            }
        } catch (e) {
            console.error('Failed to load rings:', e);
        }
    }

    recreateRing(ringData) {
        const center = L.latLng(ringData.center.lat, ringData.center.lng);
        const ringId = ringData.id || `ring_${Date.now()}_${this.ringCounter++}`;
        
        const milesToMeters = 1609.34;
        const innerRadiusMeters = ringData.radii.inner * milesToMeters;
        const middleRadiusMeters = ringData.radii.middle * milesToMeters;
        const outerRadiusMeters = ringData.radii.outer * milesToMeters;
        
        // Create rings
        const innerRing = L.circle(center, {
            radius: innerRadiusMeters,
            color: this.layerColors.ring.inner,
            weight: 3,
            fillColor: this.layerColors.ring.inner,
            fillOpacity: 0.15,
            className: 'drawn-circle inner-circle',
            interactive: true
        }).addTo(this.map);
        
        const middleRing = L.circle(center, {
            radius: middleRadiusMeters,
            color: this.layerColors.ring.middle,
            weight: 2.5,
            fillColor: this.layerColors.ring.middle,
            fillOpacity: 0.1,
            className: 'drawn-circle middle-circle',
            interactive: true
        }).addTo(this.map);
        
        const outerRing = L.circle(center, {
            radius: outerRadiusMeters,
            color: this.layerColors.ring.outer,
            weight: 2,
            fillColor: this.layerColors.ring.outer,
            fillOpacity: 0.05,
            className: 'drawn-circle outer-circle',
            interactive: true
        }).addTo(this.map);
        
        const ringObj = {
            id: ringId,
            center: center,
            layers: [innerRing, middleRing, outerRing],
            radii: ringData.radii,
            donutStats: ringData.donutStats,
            weightedStats: ringData.weightedStats,
            locations: ringData.locations,
            created: ringData.created || Date.now(),
            timestamp: ringData.timestamp || new Date().toISOString()
        };
        
        this.rings.set(ringId, ringObj);
        this.ringCreationOrder.push(ringId);
        
        // Add click handlers
        innerRing.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.activeRingId = ringId;
            this.activeRingType = 'inner';
            this.showRingPopup(ringId, 'inner');
        });
        
        middleRing.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.activeRingId = ringId;
            this.activeRingType = 'middle';
            this.showRingPopup(ringId, 'middle');
        });
        
        outerRing.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.activeRingId = ringId;
            this.activeRingType = 'outer';
            this.showRingPopup(ringId, 'outer');
        });
        
        [innerRing, middleRing, outerRing].forEach(ring => {
            ring.on('contextmenu', (e) => {
                L.DomEvent.stopPropagation(e);
                e.originalEvent.preventDefault();
                this.removeRing(ringId);
                return false;
            });
        });
    }

    removeRing(ringId) {
        const ring = this.rings.get(ringId);
        if (ring) {
            ring.layers.forEach(layer => {
                if (this.map && this.map.hasLayer(layer)) {
                    this.map.removeLayer(layer);
                }
            });
            
            this.rings.delete(ringId);
            
            const index = this.ringCreationOrder.indexOf(ringId);
            if (index > -1) {
                this.ringCreationOrder.splice(index, 1);
            }
            
            this.saveRings();
            this.closeAllPopups();
            if (this.ringListManager) this.ringListManager.updateList();
            this.showNotification('Ring removed', 'info');
        }
    }

    clearAllRings() {
        this.rings.forEach((ring) => {
            ring.layers.forEach(layer => {
                if (this.map && this.map.hasLayer(layer)) {
                    this.map.removeLayer(layer);
                }
            });
        });
        
        this.rings.clear();
        this.ringCreationOrder = [];
        
        localStorage.removeItem(this.storageKey);
        
        this.cancelDrawing();
        this.closeAllPopups();
        if (this.ringListManager) this.ringListManager.updateList();
        this.showNotification('All rings cleared', 'info');
    }

    cancelDrawing() {
        if (this.tempCircle) {
            this.map.removeLayer(this.tempCircle);
            this.tempCircle = null;
        }
        
        this.isDrawing = false;
        this.drawingLock = false;
        this.startPoint = null;
        this.map.getContainer().style.cursor = '';
    }

    closeAllPopups() {
        if (this.activePopup) {
            this.map.closePopup(this.activePopup);
            this.activePopup = null;
        }
        
        this.map.eachLayer((layer) => {
            if (layer instanceof L.Popup) {
                this.map.removeLayer(layer);
            }
        });
    }

    // ============================================================================
    // LAYER TOGGLE - CONTROLS RINGS
    // ============================================================================

    setupLayerToggleListeners() {
        setTimeout(() => {
            const toggleEducation = document.getElementById('toggleEducation');
            const toggleIncome = document.getElementById('toggleIncome');
            const toggleBoth = document.getElementById('toggleBoth');
            const toggleRings = document.getElementById('toggleRings');
            
            if (toggleEducation) {
                toggleEducation.checked = this.layerVisibility.education;
                toggleEducation.addEventListener('change', (e) => {
                    this.toggleLayer('education', e.target.checked);
                });
            }
            
            if (toggleIncome) {
                toggleIncome.checked = this.layerVisibility.income;
                toggleIncome.addEventListener('change', (e) => {
                    this.toggleLayer('income', e.target.checked);
                });
            }
            
            if (toggleBoth) {
                toggleBoth.checked = this.layerVisibility.both;
                toggleBoth.addEventListener('change', (e) => {
                    this.toggleLayer('both', e.target.checked);
                });
            }
            
            if (toggleRings) {
                toggleRings.checked = this.layerVisibility.rings;
                toggleRings.addEventListener('change', (e) => {
                    this.toggleRings(e.target.checked);
                });
            }
            
            // Apply the loaded visibility
            this.updateLayerVisibility();
            
        }, 500);
    }

    saveLayerVisibility() {
        try {
            localStorage.setItem(this.layerStorageKey, JSON.stringify(this.layerVisibility));
        } catch (e) {
            console.error('Failed to save layer visibility:', e);
        }
    }

    loadLayerVisibility() {
        try {
            const saved = localStorage.getItem(this.layerStorageKey);
            if (saved) {
                const parsed = JSON.parse(saved);
                this.layerVisibility = {
                    education: parsed.education !== undefined ? parsed.education : true,
                    income: parsed.income !== undefined ? parsed.income : true,
                    both: parsed.both !== undefined ? parsed.both : true,
                    rings: parsed.rings !== undefined ? parsed.rings : true
                };
            }
        } catch (e) {
            console.error('Failed to load layer visibility:', e);
        }
    }

    toggleLayer(layerType, visible) {
        this.layerVisibility[layerType] = visible;
        this.updateLayerVisibility();
        this.saveLayerVisibility();
    }

    toggleRings(visible) {
        this.layerVisibility.rings = visible;
        
        this.rings.forEach(ring => {
            ring.layers.forEach(layer => {
                if (visible) {
                    if (!this.map.hasLayer(layer)) this.map.addLayer(layer);
                } else {
                    if (this.map.hasLayer(layer)) this.map.removeLayer(layer);
                }
            });
        });
        
        this.saveLayerVisibility();
    }

    updateLayerVisibility() {
        this.markers.forEach(marker => {
            const type = marker.data?.markerType;
            if (type && this.layerVisibility[type] !== undefined) {
                if (this.layerVisibility[type]) {
                    if (this.markerCluster && !this.markerCluster.hasLayer(marker)) {
                        this.markerCluster.addLayer(marker);
                    }
                } else {
                    if (this.markerCluster && this.markerCluster.hasLayer(marker)) {
                        this.markerCluster.removeLayer(marker);
                    }
                }
            }
        });
        
        this.buildMarkerList();
    }

    // ============================================================================
    // HOTSPOTS - PRESERVED BUT COMMENTED OUT (FOR FUTURE USE)
    // ============================================================================

    /*
    calculateAndShowHotspots() {
        if (this.isCalculatingHotspots) {
            return;
        }
        
        this.isCalculatingHotspots = true;
        this.hotspotNotificationId = this.showNotification('Calculating top 50 county hotspots...', 'loading');
        
        this.hotspotLayers.forEach(layer => {
            if (this.map.hasLayer(layer)) {
                this.map.removeLayer(layer);
            }
        });
        this.hotspotLayers = [];
        this.hotspots = [];
        
        const markerData = [];
        
        this.markers.forEach((marker, zip) => {
            if (marker.data) {
                const latlng = marker.getLatLng();
                const county = marker.data.county || 'Unknown County';
                const state = marker.data.state || '';
                
                markerData.push({
                    lat: latlng.lat,
                    lng: latlng.lng,
                    hasEducation: marker.data.hasEducation,
                    hasIncome: marker.data.hasIncome,
                    county: county,
                    state: state,
                    zip: zip
                });
            }
        });
        
        setTimeout(() => {
            const hotspots = this.spatialUtils.findHotspots(markerData);
            const maxIntensity = hotspots.length > 0 ? hotspots[0].intensity : 1;
            
            const namedHotspots = hotspots.map((hotspot, index) => {
                const countyCounts = new Map();
                hotspot.markers.forEach(m => {
                    const county = m.county || 'Unknown County';
                    const state = m.state || '';
                    const key = `${county}, ${state}`;
                    countyCounts.set(key, (countyCounts.get(key) || 0) + 1);
                });
                
                let dominantCounty = 'Unknown County';
                let maxCount = 0;
                countyCounts.forEach((count, county) => {
                    if (count > maxCount) {
                        maxCount = count;
                        dominantCounty = county;
                    }
                });
                
                return {
                    ...hotspot,
                    rank: index + 1,
                    name: dominantCounty,
                    countyCount: maxCount,
                    totalCount: hotspot.markers.length
                };
            });
            
            this.hotspots = namedHotspots;
            
            namedHotspots.forEach(hotspot => {
                const heatLayer = L.circle([hotspot.lat, hotspot.lng], {
                    radius: hotspot.radius || 20000,
                    color: 'rgba(239, 68, 68, 0.3)',
                    weight: 1,
                    fillColor: this.spatialUtils.getHotspotColor(hotspot.intensity, maxIntensity),
                    fillOpacity: 0.2,
                    className: 'hotspot-heat-zone',
                    interactive: false
                });
                
                const borderLayer = L.circle([hotspot.lat, hotspot.lng], {
                    radius: hotspot.radius || 20000,
                    color: '#ef4444',
                    weight: 2,
                    fillOpacity: 0,
                    dashArray: '8, 8',
                    className: 'hotspot-border',
                    interactive: false
                });
                
                const label = L.marker([hotspot.lat, hotspot.lng], {
                    icon: L.divIcon({
                        html: `<div style="
                            background: #ef4444;
                            color: white;
                            padding: 8px 14px;
                            border-radius: 24px;
                            font-size: 12px;
                            font-weight: bold;
                            border: 2px solid white;
                            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                            white-space: nowrap;
                            max-width: 250px;
                            overflow: hidden;
                            text-overflow: ellipsis;
                        ">
                            <i class="fas fa-fire"></i> #${hotspot.rank}: ${hotspot.name}
                            <span style="background: rgba(255,255,255,0.2); padding: 2px 6px; border-radius: 12px; margin-left: 6px;">
                                ${hotspot.totalCount} ZIPs
                            </span>
                        </div>`,
                        className: 'hotspot-label',
                        iconSize: [240, 36],
                        iconAnchor: [120, 18]
                    }),
                    interactive: false
                });
                
                if (this.layerVisibility.hotspots) {
                    heatLayer.addTo(this.map);
                    borderLayer.addTo(this.map);
                    label.addTo(this.map);
                }
                
                this.hotspotLayers.push(heatLayer, borderLayer, label);
            });
            
            if (this.hotspotNotificationId !== null) {
                this.hideNotification(this.hotspotNotificationId);
                this.hotspotNotificationId = null;
            }
            
            this.showNotification(`Found ${hotspots.length} county hotspots`, 'success');
            
            if (window.acsApp) {
                window.acsApp.updateHotspotList(namedHotspots);
            }
            
            this.isCalculatingHotspots = false;
            
        }, 100);
    }

    toggleHotspots(visible) {
        this.layerVisibility.hotspots = visible;
        this.hotspotLayers.forEach(layer => {
            if (this.map.hasLayer(layer)) {
                if (!visible) this.map.removeLayer(layer);
            } else {
                if (visible) this.map.addLayer(layer);
            }
        });
        this.saveLayerVisibility();
    }
    */

    // ============================================================================
    // KEYBOARD NAVIGATION
    // ============================================================================

    setupKeyboardNavigation() {
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }
            
            const key = e.key.toLowerCase();
            const shift = e.shiftKey;
            const now = Date.now();
            
            // Arrow keys = Pan the map
            if (key === 'arrowup' || key === 'arrowdown' || key === 'arrowleft' || key === 'arrowright') {
                e.preventDefault();
                
                const panSpeed = shift ? 0.5 : 0.2;
                const center = this.map.getCenter();
                let newLat = center.lat;
                let newLng = center.lng;
                
                if (key === 'arrowup') newLat += panSpeed;
                if (key === 'arrowdown') newLat -= panSpeed;
                if (key === 'arrowleft') newLng -= panSpeed;
                if (key === 'arrowright') newLng += panSpeed;
                
                this.map.panTo([newLat, newLng], { animate: true });
                return;
            }
            
            // WASD = Navigate to nearest marker in that direction
            if (key === 'w' || key === 'a' || key === 's' || key === 'd') {
                e.preventDefault();
                
                if (now - this.lastNavigationTime < this.navigationCooldown) {
                    return;
                }
                this.lastNavigationTime = now;
                
                if (this.markerList.length === 0) {
                    this.buildMarkerList();
                }
                
                if (this.markerList.length === 0) return;
                
                const currentCenter = this.map.getCenter();
                const currentLat = currentCenter.lat;
                const currentLng = currentCenter.lng;
                
                let bestMarker = null;
                let bestDistance = Infinity;
                let bestIndex = -1;
                
                this.markerList.forEach((marker, index) => {
                    const latlng = marker.getLatLng();
                    const lat = latlng.lat;
                    const lng = latlng.lng;
                    
                    const latDiff = lat - currentLat;
                    const lngDiff = lng - currentLng;
                    const distance = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
                    
                    let isInDirection = false;
                    
                    if (key === 'w' && lat > currentLat) { // North
                        isInDirection = true;
                    } else if (key === 's' && lat < currentLat) { // South
                        isInDirection = true;
                    } else if (key === 'a' && lng < currentLng) { // West
                        isInDirection = true;
                    } else if (key === 'd' && lng > currentLng) { // East
                        isInDirection = true;
                    }
                    
                    if (isInDirection && distance < bestDistance) {
                        bestDistance = distance;
                        bestMarker = marker;
                        bestIndex = index;
                    }
                });
                
                if (bestMarker) {
                    this.currentMarkerIndex = bestIndex;
                    
                    const latlng = bestMarker.getLatLng();
                    
                    this.map.flyTo(latlng, Math.max(this.map.getZoom(), 10), {
                        duration: 0.6
                    });
                    
                    setTimeout(() => {
                        this.closeAllPopups();
                        this.showMarkerPopup(bestMarker, bestMarker.zip);
                    }, 600);
                }
                
                return;
            }
            
            // OTHER KEYBOARD SHORTCUTS
            if (key === '+' || key === '=') {
                this.map.zoomIn();
                e.preventDefault();
            }
            if (key === '-' || key === '_') {
                this.map.zoomOut();
                e.preventDefault();
            }
            if (key === 'r') {
                this.map.setView([39.8283, -98.5795], 4);
                e.preventDefault();
            }
            if (key === 'h') {
                this.toggleRings(!this.layerVisibility.rings);
                e.preventDefault();
            }
            if (key === 'c') {
                this.clearAllRings();
                e.preventDefault();
            }
            if (key === 'f') {
                this.toggleFullscreen();
                e.preventDefault();
            }
            if (key === 'escape') {
                this.cancelDrawing();
                this.closeAllPopups();
                e.preventDefault();
            }
        });
    }

    buildMarkerList() {
        this.markerList = [];
        this.markers.forEach((marker) => {
            if (marker.data && this.layerVisibility[marker.data.markerType]) {
                this.markerList.push(marker);
            }
        });
        
        this.markerList.sort((a, b) => {
            const latA = a.getLatLng().lat;
            const latB = b.getLatLng().lat;
            return latB - latA;
        });
    }

    // ============================================================================
    // COORDINATES DISPLAY
    // ============================================================================

    setupCoordinatesDisplay() {
        const latEl = document.getElementById('currentLat');
        const lngEl = document.getElementById('currentLng');
        const zoomEl = document.getElementById('currentZoom');
        const modeEl = document.getElementById('drawingMode');
        
        if (latEl && lngEl && zoomEl) {
            this.map.on('mousemove', (e) => {
                latEl.textContent = e.latlng.lat.toFixed(5);
                lngEl.textContent = e.latlng.lng.toFixed(5);
            });
            
            this.map.on('zoomend', () => {
                zoomEl.textContent = this.map.getZoom();
            });
            
            zoomEl.textContent = this.map.getZoom();
        }
        
        if (modeEl) {
            setInterval(() => {
                if (this.isDrawing) {
                    modeEl.textContent = 'Drawing';
                    modeEl.style.color = '#10b981';
                } else {
                    modeEl.textContent = 'View';
                    modeEl.style.color = '#6b7280';
                }
            }, 100);
        }
    }

    // ============================================================================
    // MARKER METHODS - ORIGINAL RESTORED
    // ============================================================================

    createMarker(point) {
        if (!point.lat || !point.lng || isNaN(point.lat) || isNaN(point.lng)) {
            return null;
        }
        
        let value;
        if (point.markerType === 'both') {
            value = Math.max(point.totalHigherEd || 1000, point.totalHighIncomeHouseholds || 1000);
        } else if (point.markerType === 'education') {
            value = point.totalHigherEd || 1000;
        } else {
            value = point.totalHighIncomeHouseholds || 1000;
        }
        
        const radius = this.calculateMarkerSize(value, point.markerType);
        const color = point.color || this.layerColors.both;
        
        const marker = L.circleMarker([point.lat, point.lng], {
            radius: radius,
            fillColor: color,
            color: '#ffffff',
            weight: 1.5,
            opacity: 0.9,
            fillOpacity: 0.9,
            className: `acs-marker marker-${point.markerType}`
        });
        
        marker.data = {
            hasEducation: point.hasEducation,
            hasIncome: point.hasIncome,
            totalHigherEd: point.totalHigherEd,
            totalHighIncomeHouseholds: point.totalHighIncomeHouseholds,
            medianIncome: point.medianIncome,
            location: point.location,
            city: point.city,
            county: point.county,
            state: point.state,
            markerType: point.markerType
        };
        marker.zip = point.zip;
        
        marker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.showMarkerPopup(marker, point.zip);
        });
        
        return marker;
    }

    calculateMarkerSize(value, type) {
        let scaledValue = Math.sqrt(value) * 0.15;
        
        if (type === 'both') {
            return Math.min(Math.max(scaledValue, 8), 20);
        } else {
            return Math.min(Math.max(scaledValue, 5), 16);
        }
    }

    showMarkerPopup(marker, zip) {
        const data = marker.data;
        const latlng = marker.getLatLng();
        
        const location = data.location || 'Unknown location';
        const hasEducation = data.hasEducation ? '✅ Yes (≥1,000)' : '❌ No';
        const hasIncome = data.hasIncome ? '✅ Yes (≥1,000)' : '❌ No';
        
        const higherEd = data.totalHigherEd ? data.totalHigherEd.toLocaleString() : '0';
        const highIncome = data.totalHighIncomeHouseholds ? data.totalHighIncomeHouseholds.toLocaleString() : '0';
        const medianIncome = data.medianIncome ? `$${data.medianIncome.toLocaleString()}` : 'N/A';
        
        let markerType = '';
        let bgColor = '';
        
        if (data.hasEducation && data.hasIncome) {
            markerType = 'Both Criteria';
            bgColor = '#8b5cf6';
        } else if (data.hasEducation) {
            markerType = 'Education Only';
            bgColor = '#3b82f6';
        } else if (data.hasIncome) {
            markerType = 'Income Only';
            bgColor = '#ef4444';
        }
        
        const popupContent = `
            <div style="padding: 16px; min-width: 280px; max-width: 320px; background: white;">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
                    <div style="background: ${bgColor}; width: 16px; height: 16px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.2);"></div>
                    <div style="font-weight: bold; color: #1f2937; font-size: 16px;">
                        ${location}
                        <span style="font-size: 11px; color: #6b7280; margin-left: 6px; font-weight: normal;">${zip}</span>
                    </div>
                </div>
                
                ${data.county ? `
                <div style="background: #f3f4f6; padding: 10px; border-radius: 8px; margin-bottom: 16px;">
                    <div style="display: flex; justify-content: space-between; font-size: 13px;">
                        <span style="color: #4b5563;">County:</span>
                        <span style="font-weight: 600; color: #1f2937;">${data.county}</span>
                    </div>
                    ${data.city ? `
                    <div style="display: flex; justify-content: space-between; font-size: 13px; margin-top: 6px;">
                        <span style="color: #4b5563;">City:</span>
                        <span style="font-weight: 600; color: #1f2937;">${data.city}</span>
                    </div>
                    ` : ''}
                </div>
                ` : ''}
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
                    <div style="background: #1e40af; padding: 12px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 11px; color: #bfdbfe; font-weight: 600; margin-bottom: 4px;">Higher Education</div>
                        <div style="font-weight: 700; color: white; font-size: 18px;">${higherEd}</div>
                        <div style="font-size: 10px; color: #bfdbfe; margin-top: 4px;">${hasEducation}</div>
                    </div>
                    <div style="background: #991b1b; padding: 12px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 11px; color: #fee2e2; font-weight: 600; margin-bottom: 4px;">High Income HH</div>
                        <div style="font-weight: 700; color: white; font-size: 18px;">${highIncome}</div>
                        <div style="font-size: 10px; color: #fee2e2; margin-top: 4px;">${hasIncome}</div>
                    </div>
                </div>
                
                <div style="background: #f9fafb; padding: 12px; border-radius: 8px;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                        <span style="font-size: 13px; color: #4b5563;">Median Income:</span>
                        <span style="font-weight: 700; color: #1f2937; font-size: 16px;">${medianIncome}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between;">
                        <span style="font-size: 13px; color: #4b5563;">Marker Type:</span>
                        <span style="font-weight: 600; color: ${bgColor};">${markerType}</span>
                    </div>
                </div>
                
                <div style="margin-top: 12px; font-size: 10px; color: #6b7280; display: flex; justify-content: space-between;">
                    <span><i class="fas fa-database"></i> ACS 2022</span>
                    <span><i class="fas fa-vector-square"></i> Threshold: 1,000+</span>
                </div>
            </div>
        `;
        
        this.activePopup = L.popup({
            maxWidth: 350,
            className: 'marker-popup',
            autoClose: false,
            closeButton: true,
            offset: [0, -10]
        })
        .setLatLng(latlng)
        .setContent(popupContent)
        .openOn(this.map);
    }

    // ============================================================================
    // DATA VISUALIZATION
    // ============================================================================

    visualizeCombinedData(zipData, acsData) {
        this.clear();
        
        if (!acsData || Object.keys(acsData).length === 0) {
            console.warn('No data to visualize');
            return;
        }
        
        const dataPoints = this.prepareDataPoints(zipData, acsData);
        
        dataPoints.forEach(point => {
            const marker = this.createMarker(point);
            if (marker) {
                this.markers.set(point.zip, marker);
                
                if (this.layerVisibility[point.markerType]) {
                    if (this.config.enableClustering && this.markerCluster) {
                        this.markerCluster.addLayer(marker);
                    } else {
                        marker.addTo(this.map);
                    }
                }
            }
        });
        
        this.buildMarkerList();
        
        setTimeout(() => {
            this.loadSavedRings();
        }, 500);
    }

    prepareDataPoints(zipData, acsData) {
        const dataPoints = [];
        
        Object.entries(acsData).forEach(([zip, acsRecord]) => {
            const zipRecord = zipData.get(zip);
            if (!zipRecord || !acsRecord?.data) return;
            
            const hasEducation = acsRecord.metadata?.hasEducation || false;
            const hasIncome = acsRecord.metadata?.hasIncome || false;
            
            if (!hasEducation && !hasIncome) return;
            
            let color;
            let markerType;
            if (hasEducation && hasIncome) {
                color = this.layerColors.both;
                markerType = 'both';
            } else if (hasEducation) {
                color = this.layerColors.education;
                markerType = 'education';
            } else {
                color = this.layerColors.income;
                markerType = 'income';
            }
            
            dataPoints.push({
                zip,
                lat: zipRecord.lat,
                lng: zipRecord.lng,
                color,
                markerType,
                hasEducation,
                hasIncome,
                totalHigherEd: acsRecord.data.Higher_Education || 0,
                totalHighIncomeHouseholds: acsRecord.data.High_Income_Households || 0,
                medianIncome: acsRecord.data.Median_Income,
                location: `${zipRecord.city || ''}, ${zipRecord.state_id || ''}`.trim().replace(/^,\s*/, '') || zip,
                city: zipRecord.city || '',
                county: zipRecord.county_name || '',
                state: zipRecord.state_id || ''
            });
        });
        
        return dataPoints;
    }

    createClusterIcon(cluster) {
        const childCount = cluster.getChildCount();
        const markers = cluster.getAllChildMarkers();
        
        let color = '#6b7280';
        let hasBoth = false;
        
        for (const marker of markers) {
            if (marker.data?.hasEducation && marker.data?.hasIncome) {
                hasBoth = true;
                break;
            }
        }
        
        if (hasBoth) {
            color = this.layerColors.both;
        }
        
        const size = Math.min(35 + Math.sqrt(childCount) * 2, 55);
        
        return L.divIcon({
            html: `<div style="
                background-color: ${color};
                color: white;
                width: ${size}px;
                height: ${size}px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                font-size: ${childCount < 100 ? '13px' : '11px'};
                border: 2px solid white;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            ">${childCount}</div>`,
            className: 'marker-cluster',
            iconSize: L.point(size, size)
        });
    }

    // ============================================================================
    // NOTIFICATION HELPERS
    // ============================================================================

    showNotification(message, type = 'info') {
        if (window.acsApp) {
            return window.acsApp.showNotification(message, type);
        }
        return null;
    }

    hideNotification(id) {
        if (window.acsApp) {
            if (id === 'loading' || id === undefined) {
                window.acsApp.hideNotification();
            } else {
                window.acsApp.hideNotification(id);
            }
        }
    }

    // ============================================================================
    // FULLSCREEN TOGGLE
    // ============================================================================

    toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
            const fullscreenBtn = document.getElementById('fullscreenBtn');
            if (fullscreenBtn) {
                fullscreenBtn.innerHTML = '<i class="fas fa-compress"></i>';
            }
            this.showNotification('Fullscreen mode', 'info');
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
                const fullscreenBtn = document.getElementById('fullscreenBtn');
                if (fullscreenBtn) {
                    fullscreenBtn.innerHTML = '<i class="fas fa-expand"></i>';
                }
                this.showNotification('Exited fullscreen', 'info');
            }
        }
    }

    // ============================================================================
    // UTILITIES
    // ============================================================================

    clear() {
        this.markers.forEach(marker => {
            if (this.markerCluster) {
                this.markerCluster.removeLayer(marker);
            }
            marker.remove();
        });
        this.markers.clear();
        this.markerList = [];
        this.currentMarkerIndex = -1;
        
        if (this.markerCluster) {
            this.markerCluster.clearLayers();
        }
        
        // Clear rings but don't remove from localStorage
        this.rings.forEach(ring => {
            ring.layers.forEach(layer => {
                if (this.map.hasLayer(layer)) {
                    this.map.removeLayer(layer);
                }
            });
        });
        
        // Clear hotspots if any (preserved)
        this.hotspotLayers.forEach(layer => {
            if (this.map.hasLayer(layer)) {
                this.map.removeLayer(layer);
            }
        });
        this.hotspotLayers = [];
        this.hotspots = [];
        
        this.closeAllPopups();
    }
}

if (typeof window !== 'undefined') {
    window.ACSMapVisualizer = ACSMapVisualizer;
}
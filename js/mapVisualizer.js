// ============================================================================
// MAP VISUALIZATION ENGINE - COMPLETE FIXED VERSION
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
        this.hotspots = [];
        this.hotspotLayers = [];
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
            hotspots: true
        };
        
        // Spatial utilities
        this.spatialUtils = new SpatialUtils();
        
        // Circle drawing state
        this.isDrawing = false;
        this.tempCircle = null;
        this.startPoint = null;
        this.circles = new Map();
        this.circleCounter = 0;
        this.circleCreationOrder = [];
        
        // Prevent multiple drawing sessions
        this.drawingLock = false;
        
        // Hotspot calculation state
        this.isCalculatingHotspots = false;
        this.hotspotNotificationId = null;
        
        // Active circle popup state
        this.activeCircleId = null;
        this.activeCircleRing = 'inner';
        
        // Storage keys
        this.storageKey = 'acs_map_circles_v1';
        this.layerStorageKey = 'acs_map_layers_v1';
        
        this.layerColors = {
            education: '#3b82f6',
            income: '#ef4444',
            both: '#8b5cf6',
            hotspot: '#ef4444',
            hotspotFill: 'rgba(239, 68, 68, 0.15)',
            circle: {
                inner: '#10b981',     // Green - 5 miles
                middle: '#f59e0b',    // Orange - 10 miles
                outer: '#ef4444'      // Red - 20 miles
            }
        };

        this.initMap();
        this.setupCircleDrawing();
        this.setupKeyboardNavigation();
        this.setupCoordinatesDisplay();
        this.setupLayerToggleListeners();
        
        // Load saved layer visibility
        this.loadLayerVisibility();
        
        // Load saved circles after map is initialized
        setTimeout(() => {
            this.loadSavedCircles();
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
    // LAYER VISIBILITY PERSISTENCE
    // ============================================================================

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
                    hotspots: parsed.hotspots !== undefined ? parsed.hotspots : true
                };
                
                // Update checkboxes after map is ready
                setTimeout(() => {
                    this.updateLayerCheckboxes();
                    this.updateLayerVisibility();
                }, 500);
            }
        } catch (e) {
            console.error('Failed to load layer visibility:', e);
        }
    }

    updateLayerCheckboxes() {
        const toggleEducation = document.getElementById('toggleEducation');
        const toggleIncome = document.getElementById('toggleIncome');
        const toggleBoth = document.getElementById('toggleBoth');
        const toggleHotspots = document.getElementById('toggleHotspots');
        
        if (toggleEducation) toggleEducation.checked = this.layerVisibility.education;
        if (toggleIncome) toggleIncome.checked = this.layerVisibility.income;
        if (toggleBoth) toggleBoth.checked = this.layerVisibility.both;
        if (toggleHotspots) toggleHotspots.checked = this.layerVisibility.hotspots;
    }

    // ============================================================================
    // PERSISTENT CIRCLE STORAGE
    // ============================================================================

    saveCircles() {
        try {
            const circlesData = [];
            this.circles.forEach((circle, id) => {
                circlesData.push({
                    id: id,
                    center: {
                        lat: circle.center.lat,
                        lng: circle.center.lng
                    },
                    radii: circle.radii,
                    timestamp: circle.timestamp,
                    created: circle.created
                });
            });
            
            localStorage.setItem(this.storageKey, JSON.stringify(circlesData));
        } catch (e) {
            console.error('Failed to save circles:', e);
        }
    }

    loadSavedCircles() {
        try {
            const saved = localStorage.getItem(this.storageKey);
            if (!saved) return;
            
            const circlesData = JSON.parse(saved);
            if (!Array.isArray(circlesData)) return;
            
            // Clear any existing circles first
            this.circles.forEach((circle) => {
                circle.layers.forEach(layer => {
                    if (this.map && this.map.hasLayer(layer)) {
                        this.map.removeLayer(layer);
                    }
                });
            });
            this.circles.clear();
            this.circleCreationOrder = [];
            
            // Load saved circles
            circlesData.forEach(circleData => {
                this.recreateCircle(circleData);
            });
            
            if (circlesData.length > 0) {
                this.showNotification(`Loaded ${circlesData.length} saved circles`, 'info');
            }
        } catch (e) {
            console.error('Failed to load circles:', e);
        }
    }

    recreateCircle(circleData) {
        const center = L.latLng(circleData.center.lat, circleData.center.lng);
        const circleId = circleData.id || `circle_${Date.now()}_${this.circleCounter++}`;
        
        // Convert miles to meters for drawing
        const milesToMeters = 1609.34;
        
        const innerRadiusMeters = circleData.radii.inner * milesToMeters;
        const middleRadiusMeters = circleData.radii.middle * milesToMeters;
        const outerRadiusMeters = circleData.radii.outer * milesToMeters;
        
        // Create INNER circle (Green)
        const innerCircle = L.circle(center, {
            radius: innerRadiusMeters,
            color: this.layerColors.circle.inner,
            weight: 3,
            fillColor: this.layerColors.circle.inner,
            fillOpacity: 0.15,
            className: 'drawn-circle inner-circle',
            interactive: true
        }).addTo(this.map);
        
        // Create MIDDLE circle (Orange)
        const middleCircle = L.circle(center, {
            radius: middleRadiusMeters,
            color: this.layerColors.circle.middle,
            weight: 2.5,
            fillColor: this.layerColors.circle.middle,
            fillOpacity: 0.1,
            className: 'drawn-circle middle-circle',
            interactive: true
        }).addTo(this.map);
        
        // Create OUTER circle (Red)
        const outerCircle = L.circle(center, {
            radius: outerRadiusMeters,
            color: this.layerColors.circle.outer,
            weight: 2,
            fillColor: this.layerColors.circle.outer,
            fillOpacity: 0.05,
            className: 'drawn-circle outer-circle',
            interactive: true
        }).addTo(this.map);
        
        // Calculate statistics for each circle
        const innerStats = this.calculateCircleStatsWithRadius(center, innerRadiusMeters);
        const middleStats = this.calculateCircleStatsWithRadius(center, middleRadiusMeters);
        const outerStats = this.calculateCircleStatsWithRadius(center, outerRadiusMeters);
        
        // Get counties and cities for each circle
        const innerLocations = this.getLocationsInCircle(center, innerRadiusMeters);
        const middleLocations = this.getLocationsInCircle(center, middleRadiusMeters);
        const outerLocations = this.getLocationsInCircle(center, outerRadiusMeters);
        
        // Store circle data
        const circleDataObj = {
            id: circleId,
            center: center,
            layers: [innerCircle, middleCircle, outerCircle],
            radii: {
                inner: circleData.radii.inner,
                middle: circleData.radii.middle,
                outer: circleData.radii.outer,
                innerMeters: innerRadiusMeters,
                middleMeters: middleRadiusMeters,
                outerMeters: outerRadiusMeters
            },
            stats: {
                inner: innerStats,
                middle: middleStats,
                outer: outerStats
            },
            locations: {
                inner: innerLocations,
                middle: middleLocations,
                outer: outerLocations
            },
            created: circleData.created || Date.now(),
            timestamp: circleData.timestamp || new Date().toISOString()
        };
        
        this.circles.set(circleId, circleDataObj);
        this.circleCreationOrder.push(circleId);
        
        // Add click handlers
        innerCircle.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.activeCircleId = circleId;
            this.activeCircleRing = 'inner';
            this.showCirclePopup(circleId, 'inner');
        });
        
        middleCircle.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.activeCircleId = circleId;
            this.activeCircleRing = 'middle';
            this.showCirclePopup(circleId, 'middle');
        });
        
        outerCircle.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.activeCircleId = circleId;
            this.activeCircleRing = 'outer';
            this.showCirclePopup(circleId, 'outer');
        });
        
        // Right-click removes all three circles
        [innerCircle, middleCircle, outerCircle].forEach(circle => {
            circle.on('contextmenu', (e) => {
                L.DomEvent.stopPropagation(e);
                e.originalEvent.preventDefault();
                this.removeCircle(circleId);
                return false;
            });
        });
    }

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
                this.toggleHotspots(!this.layerVisibility.hotspots);
                e.preventDefault();
            }
            if (key === 'c') {
                this.clearAllCircles();
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
    // CIRCLE DRAWING - FIXED SIZES: 5mi, 10mi, 20mi with 5mi max draw
    // ============================================================================

    setupCircleDrawing() {
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
                const radius = this.startPoint.distanceTo(e.latlng);
                this.tempCircle.setRadius(radius);
            }
        });

        this.map.on('click', (e) => {
            if (this.isDrawing && this.tempCircle && this.startPoint) {
                const radius = this.startPoint.distanceTo(e.latlng);
                
                if (radius > 100) {
                    this.finishDrawing(radius);
                } else {
                    this.cancelDrawing();
                    this.showNotification('Circle too small, try again', 'warning');
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
            color: this.layerColors.circle.inner,
            weight: 3,
            fillColor: this.layerColors.circle.inner,
            fillOpacity: 0.15,
            dashArray: '5, 5',
            className: 'temp-circle'
        }).addTo(this.map);
        
        this.map.getContainer().style.cursor = 'crosshair';
        
        this.showNotification('Draw circle (max 5 miles) - Creates fixed 5mi/10mi/20mi rings', 'info');
    }

    finishDrawing(baseRadiusMeters) {
        if (!this.isDrawing || !this.tempCircle || !this.startPoint) {
            this.cancelDrawing();
            return;
        }
        
        const circleId = `circle_${Date.now()}_${this.circleCounter++}`;
        const center = this.startPoint;
        
        // Convert meters to miles for checking
        const metersToMiles = 0.000621371;
        const drawnRadiusMiles = baseRadiusMeters * metersToMiles;
        
        // // LOCK THE RADIUS: Maximum 5 miles for drawing
        // if (drawnRadiusMiles > 5) {
        //     this.cancelDrawing();
        //     this.showNotification('Maximum circle size is 5 miles. Please draw a smaller circle.', 'warning');
        //     return;
        // }
        
        // FIXED RADII: Always 5, 10, 20 miles regardless of drawn size
        const innerRadiusMiles = 5;
        const middleRadiusMiles = 10;
        const outerRadiusMiles = 20;
        
        // Convert to meters for drawing
        const milesToMeters = 1609.34;
        const innerRadiusMeters = innerRadiusMiles * milesToMeters;
        const middleRadiusMeters = middleRadiusMiles * milesToMeters;
        const outerRadiusMeters = outerRadiusMiles * milesToMeters;
        
        // Create INNER circle (Green) - 5 miles
        const innerCircle = L.circle(center, {
            radius: innerRadiusMeters,
            color: this.layerColors.circle.inner,
            weight: 3,
            fillColor: this.layerColors.circle.inner,
            fillOpacity: 0.15,
            className: 'drawn-circle inner-circle',
            interactive: true
        }).addTo(this.map);
        
        // Create MIDDLE circle (Orange) - 10 miles
        const middleCircle = L.circle(center, {
            radius: middleRadiusMeters,
            color: this.layerColors.circle.middle,
            weight: 2.5,
            fillColor: this.layerColors.circle.middle,
            fillOpacity: 0.1,
            className: 'drawn-circle middle-circle',
            interactive: true
        }).addTo(this.map);
        
        // Create OUTER circle (Red) - 20 miles
        const outerCircle = L.circle(center, {
            radius: outerRadiusMeters,
            color: this.layerColors.circle.outer,
            weight: 2,
            fillColor: this.layerColors.circle.outer,
            fillOpacity: 0.05,
            className: 'drawn-circle outer-circle',
            interactive: true
        }).addTo(this.map);
        
        // Calculate statistics for each circle
        const innerStats = this.calculateCircleStatsWithRadius(center, innerRadiusMeters);
        const middleStats = this.calculateCircleStatsWithRadius(center, middleRadiusMeters);
        const outerStats = this.calculateCircleStatsWithRadius(center, outerRadiusMeters);
        
        // Get counties and cities for each circle
        const innerLocations = this.getLocationsInCircle(center, innerRadiusMeters);
        const middleLocations = this.getLocationsInCircle(center, middleRadiusMeters);
        const outerLocations = this.getLocationsInCircle(center, outerRadiusMeters);
        
        // Store circle data
        const circleData = {
            id: circleId,
            center: center,
            layers: [innerCircle, middleCircle, outerCircle],
            radii: {
                inner: innerRadiusMiles,
                middle: middleRadiusMiles,
                outer: outerRadiusMiles,
                innerMeters: innerRadiusMeters,
                middleMeters: middleRadiusMeters,
                outerMeters: outerRadiusMeters
            },
            stats: {
                inner: innerStats,
                middle: middleStats,
                outer: outerStats
            },
            locations: {
                inner: innerLocations,
                middle: middleLocations,
                outer: outerLocations
            },
            created: Date.now(),
            timestamp: new Date().toISOString()
        };
        
        this.circles.set(circleId, circleData);
        this.circleCreationOrder.push(circleId);
        
        // Add click handlers
        innerCircle.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.activeCircleId = circleId;
            this.activeCircleRing = 'inner';
            this.showCirclePopup(circleId, 'inner');
        });
        
        middleCircle.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.activeCircleId = circleId;
            this.activeCircleRing = 'middle';
            this.showCirclePopup(circleId, 'middle');
        });
        
        outerCircle.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.activeCircleId = circleId;
            this.activeCircleRing = 'outer';
            this.showCirclePopup(circleId, 'outer');
        });
        
        // Right-click removes all three circles
        [innerCircle, middleCircle, outerCircle].forEach(circle => {
            circle.on('contextmenu', (e) => {
                L.DomEvent.stopPropagation(e);
                e.originalEvent.preventDefault();
                this.removeCircle(circleId);
                return false;
            });
        });
        
        // Show inner circle popup by default
        this.activeCircleId = circleId;
        this.activeCircleRing = 'inner';
        this.closeAllPopups();
        this.showCirclePopup(circleId, 'inner');
        
        // Save circles to localStorage
        this.saveCircles();
        
        this.showNotification(
            `Fixed circles created: 5mi / 10mi / 20mi`, 
            'success'
        );
        
        this.cancelDrawing();
    }

    // ============================================================================
    // UNIFIED CIRCLE POPUP WITH NAVIGATION ARROWS
    // ============================================================================

    showCirclePopup(circleId, ringType) {
        const circle = this.circles.get(circleId);
        if (!circle) return;
        
        // Update active state
        this.activeCircleId = circleId;
        this.activeCircleRing = ringType;
        
        const center = circle.center;
        const stats = circle.stats[ringType];
        const locations = circle.locations[ringType];
        const radius = circle.radii[ringType];
        
        // Ring configuration
        const config = {
            inner: {
                color: '#10b981',
                bgColor: '#f0fdf4',
                darkColor: '#065f46',
                borderColor: '#10b981',
                cityTagColor: '#dbeafe',
                cityTagText: '#1e40af',
                name: 'INNER CIRCLE (5 mi)',
                icon: 'fa-circle'
            },
            middle: {
                color: '#f59e0b',
                bgColor: '#fff7ed',
                darkColor: '#92400e',
                borderColor: '#f59e0b',
                cityTagColor: '#fed7aa',
                cityTagText: '#92400e',
                name: 'MIDDLE CIRCLE (10 mi)',
                icon: 'fa-circle'
            },
            outer: {
                color: '#ef4444',
                bgColor: '#fef2f2',
                darkColor: '#991b1b',
                borderColor: '#ef4444',
                cityTagColor: '#fee2e2',
                cityTagText: '#991b1b',
                name: 'OUTER CIRCLE (20 mi)',
                icon: 'fa-circle'
            }
        };
        
        const cfg = config[ringType];
        
        // Create popup content as DOM elements
        const popupContent = document.createElement('div');
        popupContent.style.cssText = 'padding: 16px; min-width: 320px; max-width: 360px; background: white; color: #1f2937; border-left: 4px solid ' + cfg.color + '; position: relative;';
        
        // Navigation header
        const navDiv = document.createElement('div');
        navDiv.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;';
        
        // Left arrow
        if (ringType !== 'inner') {
            const leftBtn = document.createElement('button');
            leftBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
            leftBtn.style.cssText = 'background: ' + cfg.color + '; color: white; border: none; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,0.2);';
            leftBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.closeAllPopups();
                let prevRing = ringType === 'outer' ? 'middle' : 'inner';
                this.showCirclePopup(circleId, prevRing);
            };
            navDiv.appendChild(leftBtn);
        } else {
            const spacer = document.createElement('div');
            spacer.style.cssText = 'width: 32px;';
            navDiv.appendChild(spacer);
        }
        
        // Title
        const titleDiv = document.createElement('div');
        titleDiv.style.cssText = 'display: flex; align-items: center; gap: 8px;';
        titleDiv.innerHTML = `
            <div style="background: ${cfg.color}; color: white; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
                <i class="fas ${cfg.icon}"></i>
            </div>
            <div style="text-align: center;">
                <div style="font-weight: bold; color: ${cfg.darkColor}; font-size: 15px;">${cfg.name}</div>
                <div style="font-size: 11px; color: #6b7280;">
                    <i class="fas fa-arrows-alt-h"></i> ${radius.toFixed(1)} miles radius
                </div>
            </div>
        `;
        navDiv.appendChild(titleDiv);
        
        // Right arrow
        if (ringType !== 'outer') {
            const rightBtn = document.createElement('button');
            rightBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
            rightBtn.style.cssText = 'background: ' + cfg.color + '; color: white; border: none; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,0.2);';
            rightBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.closeAllPopups();
                let nextRing = ringType === 'inner' ? 'middle' : 'outer';
                this.showCirclePopup(circleId, nextRing);
            };
            navDiv.appendChild(rightBtn);
        } else {
            const spacer = document.createElement('div');
            spacer.style.cssText = 'width: 32px;';
            navDiv.appendChild(spacer);
        }
        
        popupContent.appendChild(navDiv);
        
        // ZIP Code Summary
        const zipDiv = document.createElement('div');
        zipDiv.style.cssText = 'background: ' + cfg.bgColor + '; border-radius: 12px; padding: 16px; margin-bottom: 16px;';
        zipDiv.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px;">
                <span style="font-size: 13px; color: #4b5563;">ZIP Codes in circle:</span>
                <span style="font-size: 24px; font-weight: bold; color: ${cfg.darkColor};">${stats.totalMarkers}</span>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div style="text-align: center;">
                    <div style="font-size: 18px; font-weight: bold; color: #1e40af;">${stats.educationOnly}</div>
                    <div style="font-size: 11px; color: #6b7280;">Education Only</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 18px; font-weight: bold; color: #991b1b;">${stats.incomeOnly}</div>
                    <div style="font-size: 11px; color: #6b7280;">Income Only</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 18px; font-weight: bold; color: #6b21a8;">${stats.bothCriteria}</div>
                    <div style="font-size: 11px; color: #6b7280;">Both Criteria</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 18px; font-weight: bold; color: ${cfg.darkColor};">${stats.totalMarkers}</div>
                    <div style="font-size: 11px; color: #6b7280;">Total ZIPs</div>
                </div>
            </div>
        `;
        popupContent.appendChild(zipDiv);
        
        // Economic Profile
        const econDiv = document.createElement('div');
        econDiv.style.cssText = 'background: #f9fafb; border-radius: 12px; padding: 16px; margin-bottom: 16px;';
        econDiv.innerHTML = `
            <div style="font-weight: 600; color: #374151; margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
                <i class="fas fa-chart-line"></i> Economic Profile
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                <span style="color: #4b5563;">Median Household Income:</span>
                <span style="font-weight: 700; color: #1f2937;">$${stats.medianIncome ? Math.round(stats.medianIncome).toLocaleString() : 'N/A'}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                <span style="color: #4b5563;">Total Higher Education:</span>
                <span style="font-weight: 700; color: #1e40af;">${Math.round(stats.totalEducation).toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
                <span style="color: #4b5563;">Total High-Income HH:</span>
                <span style="font-weight: 700; color: #991b1b;">${Math.round(stats.totalHighIncome).toLocaleString()}</span>
            </div>
        `;
        popupContent.appendChild(econDiv);
        
        // Locations
        const locDiv = document.createElement('div');
        locDiv.style.cssText = 'background: #f9fafb; border-radius: 12px; padding: 16px;';
        let locHtml = `
            <div style="font-weight: 600; color: #374151; margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
                <i class="fas fa-map-marker-alt"></i> Locations
            </div>
        `;
        
        if (locations.counties.length > 0) {
            locHtml += `
                <div style="margin-bottom: 12px;">
                    <div style="font-size: 12px; color: #4b5563; margin-bottom: 6px;">Counties (${locations.countyCount}):</div>
                    <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                        ${locations.counties.slice(0, 5).map(county => 
                            `<span style="background: #e5e7eb; padding: 4px 10px; border-radius: 16px; font-size: 11px; color: #374151;">${county}</span>`
                        ).join('')}
                        ${locations.countyCount > 5 ? `<span style="background: #e5e7eb; padding: 4px 10px; border-radius: 16px; font-size: 11px; color: #374151;">+${locations.countyCount - 5} more</span>` : ''}
                    </div>
                </div>
            `;
        }
        
        if (locations.cities.length > 0) {
            locHtml += `
                <div>
                    <div style="font-size: 12px; color: #4b5563; margin-bottom: 6px;">Cities (${locations.cityCount}):</div>
                    <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                        ${locations.cities.slice(0, 5).map(city => 
                            `<span style="background: ${cfg.cityTagColor}; padding: 4px 10px; border-radius: 16px; font-size: 11px; color: ${cfg.cityTagText};">${city}</span>`
                        ).join('')}
                        ${locations.cityCount > 5 ? `<span style="background: ${cfg.cityTagColor}; padding: 4px 10px; border-radius: 16px; font-size: 11px; color: ${cfg.cityTagText};">+${locations.cityCount - 5} more</span>` : ''}
                    </div>
                </div>
            `;
        }
        
        locDiv.innerHTML = locHtml;
        popupContent.appendChild(locDiv);
        
        // Footer
        const footerDiv = document.createElement('div');
        footerDiv.style.cssText = 'margin-top: 16px; font-size: 11px; color: #6b7280; display: flex; justify-content: space-between; padding-top: 12px; border-top: 1px solid #e5e7eb;';
        footerDiv.innerHTML = `
            <span><i class="fas fa-info-circle"></i> Right-click circle to remove all</span>
            <span><i class="fas fa-clock"></i> ${new Date(circle.timestamp).toLocaleTimeString()}</span>
        `;
        popupContent.appendChild(footerDiv);
        
        // Create and open popup
        this.activePopup = L.popup({
            maxWidth: 400,
            className: `circle-popup ${ringType}-popup`,
            autoClose: false,
            closeButton: true
        })
        .setLatLng(center)
        .setContent(popupContent)
        .openOn(this.map);
    }

    getLocationsInCircle(center, radiusMeters) {
        const counties = new Set();
        const cities = new Set();
        
        this.markers.forEach((marker) => {
            const latlng = marker.getLatLng();
            const distance = this.spatialUtils.haversineDistance(
                { lat: center.lat, lng: center.lng },
                { lat: latlng.lat, lng: latlng.lng }
            );
            
            if (distance <= radiusMeters && marker.data) {
                if (marker.data.county) counties.add(marker.data.county);
                if (marker.data.city) cities.add(marker.data.city);
            }
        });
        
        return {
            counties: Array.from(counties).sort().slice(0, 10),
            cities: Array.from(cities).sort().slice(0, 10),
            countyCount: counties.size,
            cityCount: cities.size
        };
    }

    calculateCircleStatsWithRadius(center, radiusMeters) {
        const markerData = [];
        this.markers.forEach((marker, zip) => {
            const latlng = marker.getLatLng();
            if (marker.data) {
                markerData.push({
                    lat: latlng.lat,
                    lng: latlng.lng,
                    hasEducation: marker.data.hasEducation,
                    hasIncome: marker.data.hasIncome,
                    totalHigherEd: marker.data.totalHigherEd || 0,
                    totalHighIncomeHouseholds: marker.data.totalHighIncomeHouseholds || 0,
                    medianIncome: marker.data.medianIncome
                });
            }
        });
        
        return this.spatialUtils.calculateCircleStats(markerData, center, radiusMeters);
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

    removeCircle(circleId) {
        const circle = this.circles.get(circleId);
        if (circle) {
            // Remove all three layers from the map
            circle.layers.forEach(layer => {
                if (this.map && this.map.hasLayer(layer)) {
                    this.map.removeLayer(layer);
                }
            });
            
            // Delete from Map collection
            this.circles.delete(circleId);
            
            // Remove from creation order array
            const index = this.circleCreationOrder.indexOf(circleId);
            if (index > -1) {
                this.circleCreationOrder.splice(index, 1);
            }
            
            // Save updated circles to storage
            this.saveCircles();
            
            this.closeAllPopups();
            this.showNotification('Triple circles removed', 'info');
        }
    }

    clearAllCircles() {
        // Remove all circle layers from the map
        this.circles.forEach((circle) => {
            circle.layers.forEach(layer => {
                if (this.map && this.map.hasLayer(layer)) {
                    this.map.removeLayer(layer);
                }
            });
        });
        
        // Clear all collections
        this.circles.clear();
        this.circleCreationOrder = [];
        
        // Clear from storage
        localStorage.removeItem(this.storageKey);
        
        this.cancelDrawing();
        this.closeAllPopups();
        this.showNotification('All circles cleared', 'info');
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
    // HOTSPOT DETECTION
    // ============================================================================

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

    // ============================================================================
    // LAYER TOGGLE LISTENERS
    // ============================================================================

    setupLayerToggleListeners() {
        setTimeout(() => {
            const toggleEducation = document.getElementById('toggleEducation');
            const toggleIncome = document.getElementById('toggleIncome');
            const toggleBoth = document.getElementById('toggleBoth');
            const toggleHotspots = document.getElementById('toggleHotspots');
            
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
            
            if (toggleHotspots) {
                toggleHotspots.checked = this.layerVisibility.hotspots;
                toggleHotspots.addEventListener('change', (e) => {
                    this.toggleHotspots(e.target.checked);
                });
            }
            
            // Apply the loaded visibility
            this.updateLayerVisibility();
            
        }, 500);
    }

    toggleLayer(layerType, visible) {
        this.layerVisibility[layerType] = visible;
        this.updateLayerVisibility();
        this.saveLayerVisibility();
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
    // MARKER CREATION
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
            this.calculateAndShowHotspots();
            
            // Reload circles after data is loaded
            this.loadSavedCircles();
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
        
        this.hotspotLayers.forEach(layer => {
            if (this.map.hasLayer(layer)) {
                this.map.removeLayer(layer);
            }
        });
        this.hotspotLayers = [];
        this.hotspots = [];
        
        // Don't clear circles on data reload - keep them
        this.closeAllPopups();
    }

    flyToHotspot(rank) {
        if (rank > 0 && rank <= this.hotspots.length) {
            const hotspot = this.hotspots[rank - 1];
            this.map.flyTo([hotspot.lat, hotspot.lng], 9, {
                duration: 1.5
            });
            
            setTimeout(() => {
                this.closeAllPopups();
                
                const popup = L.popup({
                    maxWidth: 300,
                    className: 'hotspot-popup'
                })
                .setLatLng([hotspot.lat, hotspot.lng])
                .setContent(`
                    <div style="padding: 12px; background: white;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                            <div style="background: #ef4444; color: white; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
                                <i class="fas fa-fire"></i>
                            </div>
                            <div>
                                <strong style="color: #1f2937;">#${hotspot.rank}: ${hotspot.name}</strong>
                                <div style="font-size: 11px; color: #6b7280;">${hotspot.totalCount} ZIP codes</div>
                            </div>
                        </div>
                        <div style="font-size: 12px; color: #4b5563;">
                            Intensity: ${Math.round(hotspot.intensity)} | ${Math.round(hotspot.countyCount / hotspot.totalCount * 100)}% ${hotspot.name.split(',')[0]}
                        </div>
                    </div>
                `)
                .openOn(this.map);
                
                this.activePopup = popup;
            }, 1600);
        }
    }
}

if (typeof window !== 'undefined') {
    window.ACSMapVisualizer = ACSMapVisualizer;
}
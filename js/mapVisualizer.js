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
        
        // Marker navigation - FIXED: Direction-based navigation
        this.markerList = [];
        this.currentMarkerIndex = -1;
        this.keyboardMode = 'markers';
        this.lastNavigationTime = 0;
        this.navigationCooldown = 300; // ms between navigations
        
        // County data for hotspot naming
        this.countyData = new Map();
        
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
        
        // Hotspot calculation state - FIXED: Notification management
        this.isCalculatingHotspots = false;
        this.hotspotNotificationId = null;
        
        this.layerColors = {
            education: '#3b82f6',
            income: '#ef4444',
            both: '#8b5cf6',
            hotspot: '#ef4444',
            hotspotFill: 'rgba(239, 68, 68, 0.15)',
            circle: '#10b981'
        };

        this.initMap();
        this.setupCircleDrawing();
        this.setupKeyboardNavigation();
        this.setupCoordinatesDisplay();
        this.setupLayerToggleListeners();
        this.loadCountyData();
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

        // Close all popups when clicking on map
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

        L.control.scale({ imperial: true, metric: true, position: 'bottomleft' }).addTo(this.map);
    }

    // ============================================================================
    // KEYBOARD NAVIGATION - FIXED: WASD jumps to nearest marker in direction
    // ============================================================================

    setupKeyboardNavigation() {
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }
            
            const key = e.key.toLowerCase();
            const shift = e.shiftKey;
            const now = Date.now();
            
            // ===== ARROW KEYS = Pan the map =====
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
            
            // ===== WASD = Navigate between markers by direction =====
            if (key === 'w' || key === 'a' || key === 's' || key === 'd') {
                e.preventDefault();
                
                // Cooldown to prevent too fast navigation
                if (now - this.lastNavigationTime < this.navigationCooldown) {
                    return;
                }
                this.lastNavigationTime = now;
                
                // Build marker list if empty
                if (this.markerList.length === 0) {
                    this.buildMarkerList();
                }
                
                if (this.markerList.length === 0) return;
                
                const currentCenter = this.map.getCenter();
                const currentLat = currentCenter.lat;
                const currentLng = currentCenter.lng;
                
                // Find the best marker based on direction
                let bestMarker = null;
                let bestScore = -Infinity;
                let bestIndex = -1;
                
                this.markerList.forEach((marker, index) => {
                    const latlng = marker.getLatLng();
                    const lat = latlng.lat;
                    const lng = latlng.lng;
                    
                    // Calculate direction vector
                    const latDiff = lat - currentLat;
                    const lngDiff = lng - currentLng;
                    const distance = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
                    
                    if (distance === 0) return;
                    
                    // Normalize direction vector
                    const normLat = latDiff / distance;
                    const normLng = lngDiff / distance;
                    
                    // Target direction based on key
                    let targetLat = 0, targetLng = 0;
                    if (key === 'w') targetLat = 1; // North
                    if (key === 's') targetLat = -1; // South
                    if (key === 'a') targetLng = -1; // West
                    if (key === 'd') targetLng = 1; // East
                    
                    // Calculate dot product between direction vectors
                    const dotProduct = (normLat * targetLat) + (normLng * targetLng);
                    
                    // Score based on: direction similarity + (1 / distance)
                    const directionScore = Math.max(0, dotProduct); // Only positive directions
                    const distanceScore = 1 / (distance + 0.1);
                    
                    // Weight: direction is more important than distance
                    const score = (directionScore * 2) + (distanceScore * 0.5);
                    
                    if (score > bestScore) {
                        bestScore = score;
                        bestMarker = marker;
                        bestIndex = index;
                    }
                });
                
                // If no marker in that direction, don't change
                if (bestMarker && bestScore > 0.5) {
                    this.currentMarkerIndex = bestIndex;
                    
                    // Fly to selected marker
                    const latlng = bestMarker.getLatLng();
                    
                    this.map.flyTo(latlng, Math.max(this.map.getZoom(), 10), {
                        duration: 0.6
                    });
                    
                    // Show popup
                    setTimeout(() => {
                        this.closeAllPopups();
                        this.showMarkerPopup(bestMarker, bestMarker.zip);
                    }, 600);
                }
                
                return;
            }
            
            // ===== OTHER KEYBOARD SHORTCUTS =====
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
        
        console.log(`Built marker list: ${this.markerList.length} markers for WASD navigation`);
    }

    // ============================================================================
    // CIRCLE DRAWING - Right-click drag, Left-click finish
    // ============================================================================

    setupCircleDrawing() {
        // Prevent default context menu on map
        this.map.getContainer().addEventListener('contextmenu', (e) => {
            e.preventDefault();
            return false;
        });

        // Right-click down - START DRAWING
        this.map.on('contextmenu', (e) => {
            e.originalEvent.preventDefault();
            
            if (this.drawingLock || this.isDrawing) {
                return false;
            }
            
            this.startDrawing(e.latlng);
            return false;
        });

        // Mouse move - UPDATE CIRCLE SIZE (while right button is held)
        this.map.on('mousemove', (e) => {
            if (this.isDrawing && this.tempCircle && this.startPoint) {
                const radius = this.startPoint.distanceTo(e.latlng);
                this.tempCircle.setRadius(radius);
            }
        });

        // Left-click - FINISH DRAWING AND SHOW POPUP
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

        // Right-click on existing circle - REMOVE CIRCLE
        // This is handled per-circle when created
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
            color: this.layerColors.circle,
            weight: 3,
            fillColor: this.layerColors.circle,
            fillOpacity: 0.15,
            dashArray: '5, 5',
            className: 'temp-circle'
        }).addTo(this.map);
        
        this.map.getContainer().style.cursor = 'crosshair';
        
        this.showNotification('Drag to size, left-click to finish', 'info');
    }

    finishDrawing(radius) {
        if (!this.isDrawing || !this.tempCircle || !this.startPoint) {
            this.cancelDrawing();
            return;
        }
        
        const circleId = `circle_${Date.now()}_${this.circleCounter++}`;
        const center = this.startPoint;
        
        // Create permanent circle
        const circle = L.circle(center, {
            radius: radius,
            color: this.layerColors.circle,
            weight: 2,
            fillColor: this.layerColors.circle,
            fillOpacity: 0.2,
            className: 'drawn-circle'
        }).addTo(this.map);
        
        // Store circle with timestamp
        const circleData = {
            layer: circle,
            id: circleId,
            center: center,
            radius: radius,
            created: Date.now(),
            timestamp: new Date().toISOString()
        };
        
        this.circles.set(circleId, circleData);
        this.circleCreationOrder.push(circleId);
        
        // LEFT-CLICK: Show stats popup (and close others)
        circle.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.showCircleStatsPopup(circleId);
        });
        
        // RIGHT-CLICK: Remove this circle
        circle.on('contextmenu', (e) => {
            L.DomEvent.stopPropagation(e);
            e.originalEvent.preventDefault();
            this.removeCircle(circleId);
            return false;
        });
        
        // Calculate stats and show popup
        const stats = this.calculateCircleStats(circleId);
        circle.stats = stats;
        this.closeAllPopups();
        this.showCircleStatsPopup(circleId);
        
        this.showNotification(`Circle created: ${(radius/1000).toFixed(2)}km radius`, 'success');
        
        // Clean up drawing state
        this.cancelDrawing();
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
            this.map.removeLayer(circle.layer);
            this.circles.delete(circleId);
            
            const index = this.circleCreationOrder.indexOf(circleId);
            if (index > -1) {
                this.circleCreationOrder.splice(index, 1);
            }
            
            this.closeAllPopups();
            this.showNotification('Circle removed', 'info');
        }
    }

    clearAllCircles() {
        this.circles.forEach((circle) => {
            this.map.removeLayer(circle.layer);
        });
        this.circles.clear();
        this.circleCreationOrder = [];
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

    calculateCircleStats(circleId) {
        const circle = this.circles.get(circleId);
        if (!circle || this.markers.size === 0) return null;
        
        const center = { lat: circle.center.lat, lng: circle.center.lng };
        const radius = circle.radius;
        
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
                    medianIncome: marker.data.medianIncome,
                    zip: zip,
                    county: marker.data.county || 'Unknown County',
                    city: marker.data.city || ''
                });
            }
        });
        
        const stats = this.spatialUtils.calculateCircleStats(markerData, center, radius);
        stats.circleId = circleId;
        circle.stats = stats;
        return stats;
    }

    showCircleStatsPopup(circleId) {
        const circle = this.circles.get(circleId);
        if (!circle || !circle.stats) return;
        
        const stats = circle.stats;
        const center = circle.center;
        
        this.closeAllPopups();
        
        const popupContent = `
            <div style="padding: 16px; min-width: 300px; max-width: 380px; background: white; color: #1f2937;">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
                    <div style="background: #10b981; color: white; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
                        <i class="fas fa-draw-circle"></i>
                    </div>
                    <div>
                        <div style="font-weight: bold; color: #1f2937; font-size: 15px;">Circle Analysis</div>
                        <div style="font-size: 11px; color: #6b7280;">
                            ${stats.radiusKm.toFixed(2)} km radius | ${stats.areaSqKm.toFixed(2)} km²
                        </div>
                    </div>
                </div>
                
                <div style="background: #f3f4f6; border-radius: 10px; padding: 16px; margin-bottom: 16px;">
                    <div style="font-size: 28px; font-weight: bold; color: #1f2937; text-align: center; margin-bottom: 4px;">
                        ${stats.totalMarkers}
                    </div>
                    <div style="font-size: 12px; color: #6b7280; text-align: center;">
                        ZIP codes within circle
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px;">
                    <div style="background: #eff6ff; padding: 12px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 20px; font-weight: bold; color: #1e40af;">${stats.educationOnly}</div>
                        <div style="font-size: 11px; color: #4b5563;">Education Only</div>
                    </div>
                    <div style="background: #fef2f2; padding: 12px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 20px; font-weight: bold; color: #991b1b;">${stats.incomeOnly}</div>
                        <div style="font-size: 11px; color: #4b5563;">Income Only</div>
                    </div>
                    <div style="background: #f3e8ff; padding: 12px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 20px; font-weight: bold; color: #6b21a8;">${stats.bothCriteria}</div>
                        <div style="font-size: 11px; color: #4b5563;">Both Criteria</div>
                    </div>
                    <div style="background: #ecfdf5; padding: 12px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 20px; font-weight: bold; color: #065f46;">${stats.totalMarkers}</div>
                        <div style="font-size: 11px; color: #4b5563;">Total</div>
                    </div>
                </div>
                
                <div style="background: #f9fafb; border-radius: 8px; padding: 12px; margin-bottom: 8px;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                        <span style="font-size: 12px; color: #4b5563;">Total Higher Education:</span>
                        <span style="font-weight: bold; color: #1e3a8a;">${Math.round(stats.totalEducation).toLocaleString()}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                        <span style="font-size: 12px; color: #4b5563;">Total High-Income HH:</span>
                        <span style="font-weight: bold; color: #991b1b;">${Math.round(stats.totalHighIncome).toLocaleString()}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between;">
                        <span style="font-size: 12px; color: #4b5563;">Median Income (avg):</span>
                        <span style="font-weight: bold; color: #1f2937;">$${stats.medianIncome ? Math.round(stats.medianIncome).toLocaleString() : 'N/A'}</span>
                    </div>
                </div>
                
                <div style="font-size: 11px; color: #6b7280; display: flex; justify-content: space-between; margin-top: 8px;">
                    <span><i class="fas fa-info-circle"></i> Left-click: show stats | Right-click: remove</span>
                    <span><i class="fas fa-clock"></i> ${new Date().toLocaleTimeString()}</span>
                </div>
            </div>
        `;
        
        this.activePopup = L.popup({
            maxWidth: 400,
            className: 'circle-stats-popup',
            autoClose: false,
            closeButton: true
        })
        .setLatLng(center)
        .setContent(popupContent)
        .openOn(this.map);
    }

    // ============================================================================
    // HOTSPOT DETECTION - FIXED: Notification disappears when done
    // ============================================================================

    calculateAndShowHotspots() {
        // Prevent multiple simultaneous calculations
        if (this.isCalculatingHotspots) {
            console.log('Hotspot calculation already in progress');
            return;
        }
        
        this.isCalculatingHotspots = true;
        
        // Store notification ID to close it later
        this.hotspotNotificationId = this.showNotification('Calculating top 50 county hotspots...', 'loading');
        
        // Clear existing hotspots
        this.hotspotLayers.forEach(layer => {
            if (this.map.hasLayer(layer)) {
                this.map.removeLayer(layer);
            }
        });
        this.hotspotLayers = [];
        this.hotspots = [];
        
        const markerData = [];
        const countyGroups = new Map();
        
        // Group markers by county
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
                
                // Group by county for naming
                const countyKey = `${county}|${state}`;
                if (!countyGroups.has(countyKey)) {
                    countyGroups.set(countyKey, {
                        name: county,
                        state: state,
                        count: 0,
                        markers: []
                    });
                }
                const group = countyGroups.get(countyKey);
                group.count++;
                group.markers.push(marker);
            }
        });
        
        // Use setTimeout to prevent UI blocking and ensure notification is visible
        setTimeout(() => {
            const hotspots = this.spatialUtils.findHotspots(markerData);
            const maxIntensity = hotspots.length > 0 ? hotspots[0].intensity : 1;
            
            // Name hotspots by dominant county
            const namedHotspots = hotspots.map((hotspot, index) => {
                // Find the county with most markers in this hotspot
                const countyCounts = new Map();
                hotspot.markers.forEach(m => {
                    const county = m.county || 'Unknown County';
                    const state = m.state || '';
                    const key = `${county}, ${state}`;
                    countyCounts.set(key, (countyCounts.get(key) || 0) + 1);
                });
                
                // Get the most frequent county
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
            
            // Store hotspots
            this.hotspots = namedHotspots;
            
            // Visualize hotspots
            namedHotspots.forEach(hotspot => {
                // Subtle heat zone
                const heatLayer = L.circle([hotspot.lat, hotspot.lng], {
                    radius: hotspot.radius || 20000,
                    color: 'rgba(239, 68, 68, 0.3)',
                    weight: 1,
                    fillColor: this.spatialUtils.getHotspotColor(hotspot.intensity, maxIntensity),
                    fillOpacity: 0.2,
                    className: 'hotspot-heat-zone',
                    interactive: false
                });
                
                // Border circle
                const borderLayer = L.circle([hotspot.lat, hotspot.lng], {
                    radius: hotspot.radius || 20000,
                    color: '#ef4444',
                    weight: 2,
                    fillOpacity: 0,
                    dashArray: '8, 8',
                    className: 'hotspot-border',
                    interactive: false
                });
                
                // Label with county name
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
            
            // FIXED: Hide loading notification using the stored ID
            if (this.hotspotNotificationId !== null) {
                this.hideNotification(this.hotspotNotificationId);
                this.hotspotNotificationId = null;
            }
            
            this.showNotification(`Found ${hotspots.length} county hotspots`, 'success');
            
            // Update hotspot list with county names
            if (window.acsApp) {
                window.acsApp.updateHotspotList(namedHotspots);
            }
            
            this.isCalculatingHotspots = false;
            
        }, 100); // Small delay to ensure notification is visible
    }

    // ============================================================================
    // LAYER TOGGLE LISTENERS - FIXED: Legend checkboxes work
    // ============================================================================

    setupLayerToggleListeners() {
        // Wait for DOM to be ready
        setTimeout(() => {
            const toggleEducation = document.getElementById('toggleEducation');
            const toggleIncome = document.getElementById('toggleIncome');
            const toggleBoth = document.getElementById('toggleBoth');
            const toggleHotspots = document.getElementById('toggleHotspots');
            
            if (toggleEducation) {
                toggleEducation.addEventListener('change', (e) => {
                    this.toggleLayer('education', e.target.checked);
                });
            }
            
            if (toggleIncome) {
                toggleIncome.addEventListener('change', (e) => {
                    this.toggleLayer('income', e.target.checked);
                });
            }
            
            if (toggleBoth) {
                toggleBoth.addEventListener('change', (e) => {
                    this.toggleLayer('both', e.target.checked);
                });
            }
            
            if (toggleHotspots) {
                toggleHotspots.addEventListener('change', (e) => {
                    this.toggleHotspots(e.target.checked);
                });
            }
        }, 500);
    }

    toggleLayer(layerType, visible) {
        this.layerVisibility[layerType] = visible;
        this.updateLayerVisibility();
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
        
        // Rebuild marker list for navigation
        this.buildMarkerList();
    }

    // ============================================================================
    // MARKER CREATION - FIXED: Popup text colors
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
        
        // Left-click: show popup and close others
        marker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.closeAllPopups();
            this.showMarkerPopup(marker, point.zip);
        });
        
        return marker;
    }

    calculateMarkerSize(value, type) {
        // Base size
        let baseSize = 6;
        
        // Use sqrt scaling: radius = sqrt(value) * scale
        let scaledValue = Math.sqrt(value) * 0.15;
        
        // Clamp to range
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
        
        // FIXED: White text on colored backgrounds
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
        
        console.log(`Created ${this.markers.size} markers with sqrt scaling`);
        
        // Build marker list for WASD navigation
        this.buildMarkerList();
        
        // Calculate hotspots - ensure notification is properly managed
        setTimeout(() => {
            this.calculateAndShowHotspots();
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
        
        // Update drawing mode indicator
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
    // NOTIFICATION HELPERS - FIXED
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
                // Hide all loading notifications
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

    loadCountyData() {
        // This will be populated from ZIP data
    }

    getCountyName(lat, lng) {
        let closestCounty = 'Unknown County';
        let closestDistance = Infinity;
        
        this.markers.forEach(marker => {
            const markerLatLng = marker.getLatLng();
            const distance = this.spatialUtils.haversineDistance(
                { lat, lng },
                { lat: markerLatLng.lat, lng: markerLatLng.lng }
            );
            
            if (distance < closestDistance && marker.data?.county) {
                closestDistance = distance;
                closestCounty = marker.data.county;
            }
        });
        
        return closestCounty;
    }

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
        
        this.clearAllCircles();
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

// Export to global scope
if (typeof window !== 'undefined') {
    window.ACSMapVisualizer = ACSMapVisualizer;
}
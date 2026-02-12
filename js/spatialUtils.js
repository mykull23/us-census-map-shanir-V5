// ============================================================================
// SPATIAL UTILITIES - HOTSPOT DETECTION & CIRCLE CALCULATIONS
// ============================================================================

class SpatialUtils {
    constructor() {
        this.hotspotCache = null;
        this.lastHotspotCalculation = 0;
        this.cacheDuration = 5 * 60 * 1000; // 5 minutes
    }

    /**
     * Find Top 50 Hotspots using DBSCAN-inspired spatial clustering
     * @param {Array} markers - Array of marker objects with lat, lng, value
     * @returns {Array} - Top 50 hotspots sorted by intensity
     */
    findHotspots(markers) {
        // Check cache first
        const now = Date.now();
        if (this.hotspotCache && (now - this.lastHotspotCalculation) < this.cacheDuration) {
            console.log('Returning cached hotspots');
            return this.hotspotCache;
        }

        console.log(`Calculating hotspots from ${markers.length} markers...`);
        
        if (markers.length === 0) return [];

        // Step 1: Create spatial grid (0.1 degree ~ 11km at equator)
        const gridSize = 0.1;
        const grid = new Map();
        
        markers.forEach(marker => {
            const lat = marker.lat;
            const lng = marker.lng;
            
            // Grid cell key
            const cellX = Math.floor(lat / gridSize);
            const cellY = Math.floor(lng / gridSize);
            const cellKey = `${cellX},${cellY}`;
            
            if (!grid.has(cellKey)) {
                grid.set(cellKey, {
                    markers: [],
                    totalValue: 0,
                    avgLat: 0,
                    avgLng: 0,
                    count: 0,
                    cellX,
                    cellY
                });
            }
            
            const cell = grid.get(cellKey);
            cell.markers.push(marker);
            
            // Calculate combined value - higher weight for both criteria
            let value = 0;
            if (marker.hasEducation && marker.hasIncome) {
                value = 3; // Both criteria - highest weight
            } else if (marker.hasEducation || marker.hasIncome) {
                value = 1; // Single criterion
            }
            
            cell.totalValue += value;
            cell.avgLat += marker.lat;
            cell.avgLng += marker.lng;
            cell.count++;
        });

        // Step 2: Calculate hotspot intensity and merge neighboring cells
        const hotspots = [];
        
        grid.forEach((cell, cellKey) => {
            if (cell.count === 0) return;
            
            cell.avgLat /= cell.count;
            cell.avgLng /= cell.count;
            
            // Calculate intensity: density * value weight
            const density = cell.count;
            const avgValue = cell.totalValue / cell.count;
            const intensity = density * avgValue;
            
            hotspots.push({
                id: `hotspot_${cellKey}`,
                lat: cell.avgLat,
                lng: cell.avgLng,
                count: cell.count,
                totalValue: cell.totalValue,
                intensity: intensity,
                markers: cell.markers,
                bbox: {
                    minLat: cell.cellX * gridSize,
                    maxLat: (cell.cellX + 1) * gridSize,
                    minLng: cell.cellY * gridSize,
                    maxLng: (cell.cellY + 1) * gridSize
                }
            });
        });

        // Step 3: Merge adjacent cells
        const mergedHotspots = this.mergeAdjacentCells(hotspots, gridSize * 1.5);
        
        // Step 4: Sort by intensity and take top 50
        const topHotspots = mergedHotspots
            .sort((a, b) => b.intensity - a.intensity)
            .slice(0, 50)
            .map((hotspot, index) => {
                // Calculate approximate geographic center
                const center = this.calculateGeographicCenter(hotspot.markers);
                
                return {
                    ...hotspot,
                    rank: index + 1,
                    lat: center.lat,
                    lng: center.lng,
                    radius: Math.sqrt(hotspot.count) * 5000, // Dynamic radius in meters
                    name: `Hotspot #${index + 1}`,
                    description: `${hotspot.count} markers, ${Math.round(hotspot.intensity)} intensity`
                };
            });

        console.log(`Found ${topHotspots.length} hotspots`);

        // Cache the results
        this.hotspotCache = topHotspots;
        this.lastHotspotCalculation = now;

        return topHotspots;
    }

    /**
     * Merge adjacent grid cells that are close together
     */
    mergeAdjacentCells(hotspots, mergeDistance) {
        if (hotspots.length <= 1) return hotspots;
        
        const merged = [];
        const used = new Set();
        
        for (let i = 0; i < hotspots.length; i++) {
            if (used.has(i)) continue;
            
            const cluster = {
                markers: [...hotspots[i].markers],
                count: hotspots[i].count,
                totalValue: hotspots[i].totalValue,
                intensity: hotspots[i].intensity,
                avgLat: hotspots[i].avgLat,
                avgLng: hotspots[i].avgLng
            };
            
            used.add(i);
            
            for (let j = i + 1; j < hotspots.length; j++) {
                if (used.has(j)) continue;
                
                // Calculate distance between centers
                const dx = Math.abs(hotspots[i].avgLat - hotspots[j].avgLat);
                const dy = Math.abs(hotspots[i].avgLng - hotspots[j].avgLng);
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                if (distance < mergeDistance) {
                    cluster.markers.push(...hotspots[j].markers);
                    cluster.count += hotspots[j].count;
                    cluster.totalValue += hotspots[j].totalValue;
                    cluster.intensity += hotspots[j].intensity;
                    cluster.avgLat = (cluster.avgLat + hotspots[j].avgLat) / 2;
                    cluster.avgLng = (cluster.avgLng + hotspots[j].avgLng) / 2;
                    used.add(j);
                }
            }
            
            merged.push({
                ...cluster,
                avgLat: cluster.avgLat,
                avgLng: cluster.avgLng,
                intensity: cluster.intensity
            });
        }
        
        return merged;
    }

    /**
     * Calculate geographic center of markers
     */
    calculateGeographicCenter(markers) {
        if (markers.length === 0) return { lat: 0, lng: 0 };
        
        let lat = 0, lng = 0;
        markers.forEach(m => {
            lat += m.lat;
            lng += m.lng;
        });
        
        return {
            lat: lat / markers.length,
            lng: lng / markers.length
        };
    }

    /**
     * Calculate statistics for points within a circle
     * @param {Array} markers - Array of markers
     * @param {Object} center - {lat, lng}
     * @param {number} radiusMeters - Radius in meters
     * @returns {Object} - Statistics
     */
    calculateCircleStats(markers, center, radiusMeters) {
        const result = {
            totalMarkers: 0,
            educationOnly: 0,
            incomeOnly: 0,
            bothCriteria: 0,
            totalEducation: 0,
            totalHighIncome: 0,
            medianIncomes: [],
            educationValues: [],
            incomeValues: [],
            markers: []
        };

        markers.forEach(marker => {
            const markerLatLng = { lat: marker.lat, lng: marker.lng };
            const distance = this.haversineDistance(center, markerLatLng);
            
            if (distance <= radiusMeters) {
                result.totalMarkers++;
                result.markers.push(marker);
                
                if (marker.hasEducation && marker.hasIncome) {
                    result.bothCriteria++;
                } else if (marker.hasEducation) {
                    result.educationOnly++;
                } else if (marker.hasIncome) {
                    result.incomeOnly++;
                }
                
                if (marker.totalHigherEd) {
                    result.totalEducation += marker.totalHigherEd;
                    result.educationValues.push(marker.totalHigherEd);
                }
                
                if (marker.totalHighIncomeHouseholds) {
                    result.totalHighIncome += marker.totalHighIncomeHouseholds;
                    result.incomeValues.push(marker.totalHighIncomeHouseholds);
                }
                
                if (marker.medianIncome) {
                    result.medianIncomes.push(marker.medianIncome);
                }
            }
        });

        // Calculate median income
        if (result.medianIncomes.length > 0) {
            result.medianIncomes.sort((a, b) => a - b);
            const mid = Math.floor(result.medianIncomes.length / 2);
            result.medianIncome = result.medianIncomes.length % 2 === 0
                ? (result.medianIncomes[mid - 1] + result.medianIncomes[mid]) / 2
                : result.medianIncomes[mid];
        }

        // Calculate mean values
        result.meanEducation = result.educationValues.length > 0
            ? result.totalEducation / result.educationValues.length
            : 0;
        
        result.meanHighIncome = result.incomeValues.length > 0
            ? result.totalHighIncome / result.incomeValues.length
            : 0;

        result.areaSqKm = Math.PI * Math.pow(radiusMeters / 1000, 2);
        result.radiusKm = radiusMeters / 1000;

        return result;
    }

    /**
     * Haversine distance between two points in meters
     */
    haversineDistance(p1, p2) {
        const R = 6371000; // Earth radius in meters
        const φ1 = p1.lat * Math.PI / 180;
        const φ2 = p2.lat * Math.PI / 180;
        const Δφ = (p2.lat - p1.lat) * Math.PI / 180;
        const Δλ = (p2.lng - p1.lng) * Math.PI / 180;

        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c;
    }

    /**
     * Create a heat intensity color based on value
     * @param {number} intensity - Hotspot intensity value
     * @param {number} maxIntensity - Maximum intensity in dataset
     * @returns {string} - RGBA color string
     */
    getHotspotColor(intensity, maxIntensity) {
        const ratio = intensity / maxIntensity;
        
        // Yellow (low) -> Orange -> Red (high)
        if (ratio > 0.8) {
            return `rgba(239, 68, 68, ${0.3 + (ratio * 0.2)})`; // Red
        } else if (ratio > 0.5) {
            return `rgba(249, 115, 22, ${0.2 + (ratio * 0.2)})`; // Orange
        } else if (ratio > 0.2) {
            return `rgba(245, 158, 11, ${0.15 + (ratio * 0.2)})`; // Amber
        } else {
            return `rgba(234, 179, 8, ${0.1 + (ratio * 0.2)})`; // Yellow
        }
    }

    /**
     * Calculate dynamic marker size using sqrt scaling
     * @param {number} value - The data value
     * @param {string} type - 'education', 'income', or 'both'
     * @returns {number} - Radius in pixels
     */
    calculateMarkerSize(value, type) {
        // Base size
        let baseSize = 6;
        
        // Use sqrt scaling: radius = sqrt(value) * scale
        // Normalize to reasonable range (6-18px)
        let scaledValue = Math.sqrt(value) * 0.15;
        
        // Clamp to range
        if (type === 'both') {
            return Math.min(Math.max(scaledValue, 8), 20);
        } else {
            return Math.min(Math.max(scaledValue, 5), 16);
        }
    }
}

// Export to global scope
if (typeof window !== 'undefined') {
    window.SpatialUtils = SpatialUtils;
}
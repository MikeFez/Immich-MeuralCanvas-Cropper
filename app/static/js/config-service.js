/**
 * config-service.js - Handles loading and caching of configuration
 */

window.CONFIG = {
    dimensions: null,
    initialized: false,
};

async function initializeConfig() {
    try {
        const response = await fetch('/dimensions');
        const data = await response.json();
        window.CONFIG.dimensions = data;
        window.CONFIG.initialized = true;
        return data;
    } catch (error) {
        console.error('Failed to load dimensions:', error);
        throw error;
    }
}

function getDimensions(orientation) {
    if (!window.CONFIG.initialized) {
        throw new Error('Configuration not initialized');
    }
    return window.CONFIG.dimensions[orientation];
}

function getAspectRatio(orientation) {
    const dims = getDimensions(orientation);
    return dims.width / dims.height;
}

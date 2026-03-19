const NodeCache = require('node-cache');

// Cache configuration
const CACHE_TTL = {
  POOL_BALANCES: 5,      // 5 seconds for pool balances (high frequency)
  GAME_SETTINGS: 60,     // 1 minute for game settings (low frequency)
  USER_PROFILE: 30,      // 30 seconds for user profiles
  COOLDOWN_CHECK: 10,    // 10 seconds for cooldown checks
};

const cache = new NodeCache({ 
  stdTTL: CACHE_TTL.POOL_BALANCES, 
  checkperiod: 120,
  useClones: true,
  maxKeys: 1000,
});

/**
 * Get value from cache with fallback function
 */
async function getOrSet(cacheKey, fallbackFn, ttl = null) {
  const cachedValue = cache.get(cacheKey);
  
  if (cachedValue !== undefined) {
    return cachedValue;
  }
  
  const value = await fallbackFn();
  cache.set(cacheKey, value, ttl);
  
  return value;
}

/**
 * Invalidate specific cache keys
 */
function invalidateCache(pattern) {
  const keys = cache.keys();
  keys.forEach(key => {
    if (pattern.test(key)) {
      cache.del(key);
    }
  });
}

/**
 * Clear all caches (use sparingly)
 */
function clearAll() {
  cache.flushAll();
}

/**
 * Get cache statistics for monitoring
 */
function getStats() {
  return {
    keys: cache.keys().length,
    stats: cache.getStats(),
  };
}

module.exports = {
  cache,
  CACHE_TTL,
  getOrSet,
  invalidateCache,
  clearAll,
  getStats,
};

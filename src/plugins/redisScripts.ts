/**
 * Atomic fixed-window rate-limit Lua script.
 *
 * Inputs:
 *   KEYS[1] = counter key
 *   KEYS[2] = ban key
 *   ARGV[1] = cost (integer >= 1)
 *   ARGV[2] = limit (integer >= 1)
 *   ARGV[3] = window (integer >= 1)
 *   ARGV[4] = ban (integer >= 0; 0 disables ban arming)
 *
 * Output: [count, windowTtl, banTtl]
 */
export const ATOMIC_SCRIPT = `
local counterKey = KEYS[1]
local banKey = KEYS[2]
local cost = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local ban = tonumber(ARGV[4])

local count = redis.call('INCRBY', counterKey, cost)
local ttl = redis.call('PTTL', counterKey)
if count == cost or ttl < 0 then
  redis.call('PEXPIRE', counterKey, window)
  ttl = window
end

local banTtl = 0
if ban > 0 then
  banTtl = redis.call('PTTL', banKey)
  if banTtl < 0 then banTtl = 0 end
  if count > limit and banTtl <= 0 then
    redis.call('PSETEX', banKey, ban, '1')
    banTtl = ban
  end
end

return { count, ttl, banTtl }
`.trim()

export const GCRA_SCRIPT = `
local stateKey = KEYS[1]
local banKey = KEYS[2]
local cost = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local ban = tonumber(ARGV[4])
local now = tonumber(ARGV[5])

local emission = window / limit
local burst = window
local tat = tonumber(redis.call('GET', stateKey) or now)
local banTtl = 0

if ban > 0 then
  banTtl = redis.call('PTTL', banKey)
  if banTtl < 0 then banTtl = 0 end
end

if banTtl > 0 then
  local used = math.max(tat - now, 0)
  local remaining = math.max(0, math.floor((burst - used) / emission))
  local reset = math.max(0, math.ceil(used))
  return { 1, remaining, reset, banTtl, banTtl, limit - remaining }
end

local nextTat = math.max(tat, now) + (emission * cost)
local allowAt = nextTat - burst

if now < allowAt then
  local retry = math.ceil(allowAt - now)
  if ban > 0 then
    redis.call('PSETEX', banKey, ban, '1')
    banTtl = ban
    if banTtl > retry then retry = banTtl end
  end
  local used = math.max(tat - now, 0)
  local remaining = math.max(0, math.floor((burst - used) / emission))
  local reset = math.max(0, math.ceil(used))
  return { 1, remaining, reset, retry, banTtl, limit - remaining }
end

local used = math.max(nextTat - now, 0)
local ttl = math.max(1, math.ceil(burst + used))
redis.call('PSETEX', stateKey, ttl, tostring(nextTat))
local remaining = math.max(0, math.floor((burst - used) / emission))
local reset = math.max(0, math.ceil(used))
return { 0, remaining, reset, 0, 0, limit - remaining }
`.trim()

window.patches = {
    "bit.lua": `local M = {_TYPE='module', _NAME='bitop.funcs', _VERSION='1.0-0'}

local floor = math.floor

local MOD = 2^32
local MODM = MOD-1

local function memoize(f)

  local mt = {}
  local t = setmetatable({}, mt)

  function mt:__index(k)
    local v = f(k)
    t[k] = v
    return v
  end

  return t
end

local function make_bitop_uncached(t, m)
  local function bitop(a, b)
    local res,p = 0,1
    while a ~= 0 and b ~= 0 do
      local am, bm = a%m, b%m
      res = res + t[am][bm]*p
      a = (a - am) / m
      b = (b - bm) / m
      p = p*m
    end
    res = res + (a+b) * p
    return res
  end
  return bitop
end

local function make_bitop(t)
  local op1 = make_bitop_uncached(t, 2^1)
  local op2 = memoize(function(a)
    return memoize(function(b)
      return op1(a, b)
    end)
  end)
  return make_bitop_uncached(op2, 2^(t.n or 1))
end

-- ok? probably not if running on a 32-bit int Lua number type platform
function M.tobit(x)
  return x % 2^32
end

M.bxor = make_bitop {[0]={[0]=0,[1]=1},[1]={[0]=1,[1]=0}, n=4}
local bxor = M.bxor

function M.bnot(a)   return MODM - a end
local bnot = M.bnot

function M.band(a,b)
  return ((a+b) - bxor(a,b))
end
local band = M.band

function M.bor(a,b)
  return MODM - band(MODM - a, MODM - b)
end
local bor = M.bor

local lshift, rshift -- forward declare

function M.rshift(a,disp) -- Lua5.2 insipred
  if disp < 0 then return lshift(a,-disp) end
  return floor(a % 2^32 / 2^disp)
end
rshift = M.rshift

function M.lshift(a,disp) -- Lua5.2 inspired
  if disp < 0 then return rshift(a,-disp) end
  return (a * 2^disp) % 2^32
end
lshift = M.lshift

function M.tohex(x, n) -- BitOp style
  n = n or 8
  local up
  if n <= 0 then
    if n == 0 then return '' end
    up = true
    n = - n
  end
  x = band(x, 16^n-1)
  return ('%0'..n..(up and 'X' or 'x')):format(x)
end
local tohex = M.tohex

function M.extract(n, field, width) -- Lua5.2 inspired
  width = width or 1
  return band(rshift(n, field), 2^width-1)
end
local extract = M.extract

function M.replace(n, v, field, width) -- Lua5.2 inspired
  width = width or 1
  local mask1 = 2^width-1
  v = band(v, mask1) -- required by spec?
  local mask = bnot(lshift(mask1, field))
  return band(n, mask) + lshift(v, field)
end
local replace = M.replace

function M.bswap(x)  -- BitOp style
  local a = band(x, 0xff); x = rshift(x, 8)
  local b = band(x, 0xff); x = rshift(x, 8)
  local c = band(x, 0xff); x = rshift(x, 8)
  local d = band(x, 0xff)
  return lshift(lshift(lshift(a, 8) + b, 8) + c, 8) + d
end
local bswap = M.bswap

function M.rrotate(x, disp)  -- Lua5.2 inspired
  disp = disp % 32
  local low = band(x, 2^disp-1)
  return rshift(x, disp) + lshift(low, 32-disp)
end
local rrotate = M.rrotate

function M.lrotate(x, disp)  -- Lua5.2 inspired
  return rrotate(x, -disp)
end
local lrotate = M.lrotate

M.rol = M.lrotate  -- LuaOp inspired
M.ror = M.rrotate  -- LuaOp insipred


function M.arshift(x, disp) -- Lua5.2 inspired
  local z = rshift(x, disp)
  if x >= 0x80000000 then z = z + lshift(2^disp-1, 32-disp) end
  return z
end
local arshift = M.arshift

function M.btest(x, y) -- Lua5.2 inspired
  return band(x, y) ~= 0
end

--
-- Start Lua 5.2 "bit32" compat section.
--

M.bit32 = {} -- Lua 5.2 'bit32' compatibility


local function bit32_bnot(x)
  return (-1 - x) % MOD
end
M.bit32.bnot = bit32_bnot

local function bit32_bxor(a, b, c, ...)
  local z
  if b then
    a = a % MOD
    b = b % MOD
    z = bxor(a, b)
    if c then
      z = bit32_bxor(z, c, ...)
    end
    return z
  elseif a then
    return a % MOD
  else
    return 0
  end
end
M.bit32.bxor = bit32_bxor

local function bit32_band(a, b, c, ...)
  local z
  if b then
    a = a % MOD
    b = b % MOD
    z = ((a+b) - bxor(a,b)) / 2
    if c then
      z = bit32_band(z, c, ...)
    end
    return z
  elseif a then
    return a % MOD
  else
    return MODM
  end
end
M.bit32.band = bit32_band

local function bit32_bor(a, b, c, ...)
  local z
  if b then
    a = a % MOD
    b = b % MOD
    z = MODM - band(MODM - a, MODM - b)
    if c then
      z = bit32_bor(z, c, ...)
    end
    return z
  elseif a then
    return a % MOD
  else
    return 0
  end
end
M.bit32.bor = bit32_bor

function M.bit32.btest(...)
  return bit32_band(...) ~= 0
end

function M.bit32.lrotate(x, disp)
  return lrotate(x % MOD, disp)
end

function M.bit32.rrotate(x, disp)
  return rrotate(x % MOD, disp)
end

function M.bit32.lshift(x,disp)
  if disp > 31 or disp < -31 then return 0 end
  return lshift(x % MOD, disp)
end

function M.bit32.rshift(x,disp)
  if disp > 31 or disp < -31 then return 0 end
  return rshift(x % MOD, disp)
end

function M.bit32.arshift(x,disp)
  x = x % MOD
  if disp >= 0 then
    if disp > 31 then
      return (x >= 0x80000000) and MODM or 0
    else
      local z = rshift(x, disp)
      if x >= 0x80000000 then z = z + lshift(2^disp-1, 32-disp) end
      return z
    end
  else
    return lshift(x, -disp)
  end
end

function M.bit32.extract(x, field, ...)
  local width = ... or 1
  if field < 0 or field > 31 or width < 0 or field+width > 32 then error 'out of range' end
  x = x % MOD
  return extract(x, field, ...)
end

function M.bit32.replace(x, v, field, ...)
  local width = ... or 1
  if field < 0 or field > 31 or width < 0 or field+width > 32 then error 'out of range' end
  x = x % MOD
  v = v % MOD
  return replace(x, v, field, ...)
end


--
-- Start LuaBitOp "bit" compat section.
--

M.bit = {} -- LuaBitOp "bit" compatibility

function M.bit.tobit(x)
  x = x % MOD
  if x >= 0x80000000 then x = x - MOD end
  return x
end
local bit_tobit = M.bit.tobit

function M.bit.tohex(x, ...)
  return tohex(x % MOD, ...)
end

function M.bit.bnot(x)
  return bit_tobit(bnot(x % MOD))
end

local function bit_bor(a, b, c, ...)
  if c then
    return bit_bor(bit_bor(a, b), c, ...)
  elseif b then
    return bit_tobit(bor(a % MOD, b % MOD))
  else
    return bit_tobit(a)
  end
end
M.bit.bor = bit_bor

local function bit_band(a, b, c, ...)
  if c then
    return bit_band(bit_band(a, b), c, ...)
  elseif b then
    return bit_tobit(band(a % MOD, b % MOD))
  else
    return bit_tobit(a)
  end
end
M.bit.band = bit_band

local function bit_bxor(a, b, c, ...)
  if c then
    return bit_bxor(bit_bxor(a, b), c, ...)
  elseif b then
    return bit_tobit(bxor(a % MOD, b % MOD))
  else
    return bit_tobit(a)
  end
end
M.bit.bxor = bit_bxor

function M.bit.lshift(x, n)
  return bit_tobit(lshift(x % MOD, n % 32))
end

function M.bit.rshift(x, n)
  return bit_tobit(rshift(x % MOD, n % 32))
end

function M.bit.arshift(x, n)
  return bit_tobit(arshift(x % MOD, n % 32))
end

function M.bit.rol(x, n)
  return bit_tobit(lrotate(x % MOD, n % 32))
end

function M.bit.ror(x, n)
  return bit_tobit(rrotate(x % MOD, n % 32))
end

function M.bit.bswap(x)
  return bit_tobit(bswap(x % MOD))
end

return M`,
// -------------------------------------------------------------------------------
    "web_patches.lua": `-- Other patches not in this file:
-- Disable steam integration
-- F_SOUND_THREAD = false

love.system.getOS = function()
  return "Windows"
end

-- LuaJIT's string.format accepts any value for %s and runs it through
-- tostring(); plain Lua 5.1 raises instead. The game and its mods rely on the
-- LuaJIT behaviour - formatting a nil into a key with ('%s_%s'):format(k, v) is
-- commonplace - so coerce the arguments rather than letting it raise.
--
-- Returning something wrong here is far worse than raising: this used to catch
-- the error and hand back the format's first argument, which silently turned
-- Steamodded's "does a localised copy of this atlas exist?" check into "yes",
-- and every mod atlas was dropped.
local _format = string.format
local _unpack = unpack or table.unpack
function string.format(fmt, ...)
    local count = select("#", ...)
    local args = { ... }
    for i = 1, count do
        local kind = type(args[i])
        if kind ~= "string" and kind ~= "number" then
            args[i] = tostring(args[i])
        end
    end
    return _format(fmt, _unpack(args, 1, count))
end

function override_setMipmapFilter(texture)
    getmetatable(texture).__index.setMipmapFilter = function() end
    return texture
end

local _newImage = love.graphics.newImage
love.graphics.newImage = function(path, config)
    config = config or {} -- Mods call newImage with no settings table
    config.mipmaps = false -- Disable mipmaps for web compatibility
    return override_setMipmapFilter(_newImage(path, config))
end


local _quit = love.event.quit
love.event.quit = function(arg)
    -- The game cannot relaunch itself in a browser tab, and quitting leaves a
    -- dead canvas behind, so a requested restart is reported instead.
    if arg == "restart" then
        print("Ignoring restart request: reload the page to restart.")
        return
    end
    print("Quitting game...")
    _quit(arg)
end

-- Mods regularly probe LuaJIT and the OS for platform checks. love.js runs
-- plain Lua 5.1 inside a sandbox, so give them something to read instead of nil.
jit = jit or {
    arch = "web",
    os = "Other",
    version = "Lua 5.1 (love.js)",
    version_num = 20100,
    status = function() return false end,
    off = function() end,
    on = function() end,
    flush = function() end,
}

os.execute = os.execute or function() return -1 end
os.getenv = os.getenv or function() return nil end

-- WebGL is OpenGL ES, which refuses to compare a float against an integer
-- literal. Shaders written for desktop GL do that freely, and Steamodded ships
-- some; natively it repairs them as they load, through a Lovely hook this build
-- cannot provide. Repair the common case here instead.
--
-- This matters more than a missing effect: a shader that fails to compile
-- leaves a half-built object behind, and the runtime traps when it is collected,
-- taking the whole game down.
-- Split a constructor's argument list on the commas that are not nested.
local function split_args(text)
    local args, depth, start = {}, 0, 1
    for i = 1, #text do
        local ch = text:sub(i, i)
        if ch == "(" then depth = depth + 1
        elseif ch == ")" then depth = depth - 1
        elseif ch == "," and depth == 0 then
            args[#args + 1] = text:sub(start, i - 1)
            start = i + 1
        end
    end
    args[#args + 1] = text:sub(start)
    return args
end

local function trim(s)
    return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- GLSL ES 1.00 has neither array constructors nor initialised globals, so
--     vec2 n[8] = vec2[8](a, b, ...);   ... n[i] ...
-- is rewritten into a lookup function:
--     vec2 n_get(int i) { if (i == 0) return a; ... }   ... n_get(i) ...
local function fix_array_constructors(code)
    local guard = 0
    while guard < 16 do
        guard = guard + 1
        local s, e, ctype, name = code:find(
            "([%a_][%w_]*)%s+([%a_][%w_]*)%s*%[%s*%d*%s*%]%s*=%s*[%a_][%w_]*%s*%[%s*%d*%s*%]%s*%(")
        if not s then break end

        local depth, i = 1, e + 1
        while i <= #code and depth > 0 do
            local ch = code:sub(i, i)
            if ch == "(" then depth = depth + 1 elseif ch == ")" then depth = depth - 1 end
            i = i + 1
        end
        if depth ~= 0 then break end

        local args = split_args(code:sub(e + 1, i - 2))
        local semicolon = code:find(";", i - 1, true) or (i - 1)

        local body = {}
        for idx, arg in ipairs(args) do
            body[#body + 1] = ("if (i == %d) { return %s; }"):format(idx - 1, trim(arg))
        end
        local getter = ("%s %s_get(int i) { %s return %s; }"):format(
            ctype, name, table.concat(body, " "), trim(args[1]))

        code = code:sub(1, s - 1) .. getter .. code:sub(semicolon + 1)
        code = code:gsub(name .. "%s*%[([^%[%]]-)%]", name .. "_get(%1)")
    end
    return code
end

local _newShader = love.graphics.newShader
love.graphics.newShader = function(code, other_code)
    if type(code) == "string" and code:find("\\n", 1, true) then
        code = fix_array_constructors(code)
        -- "uv.x < 0" becomes "uv.x < 0.0", and the same with the operands swapped
        code = code:gsub("([%a_][%w_]*%.[xyzwrgba])(%s*[<>]=?%s*)(%d+)([^%.%d])", "%1%2%3.0%4")
        code = code:gsub("([^%.%w_])(%d+)(%s*[<>]=?%s*)([%a_][%w_]*%.[xyzwrgba])", "%1%2.0%3%4")
    end
    return _newShader(code, other_code)
end

local _randomSeed = math.randomseed
math.randomseed = function(seed)
    if math.floor(seed) ~= seed then -- Non integer seeds do not work on web contexts
        -- Issue #4 (https://github.com/W0W53R/web-balatro/issues/4): Non seeded runs are all the same
        _randomSeed((seed % 1) * 2147483647, math.floor(seed))  -- Seperate digit and decimal parts to ensure randomness
        return
    end
    _randomSeed(seed)
end

-- The fake threads below are chatty; this logs every channel message, every
-- frame, which floods the console and costs frames. Set it to true when
-- debugging the thread shims.
WEB_DEBUG_CHANNELS = false

local prevthread = nil

local FakeThread = {}

function FakeThread:new(thread)
    -- This is a fake thread class to replace love.thread.Thread
    local obj = {}
    obj._thread = thread or coroutine.create(function() end) -- Default to a no-op coroutine
    setmetatable(obj, self)
    self.__index = self
    return obj
end

function FakeThread:start(...)
    -- Resume the coroutine, passing any arguments
    return coroutine.resume(self._thread, ...)
end

local FakeChannel = {}

function FakeChannel:new(name)
    local obj = {}
    obj.queue = {}
    obj._thread = prevthread and prevthread._thread or nil -- Associate with the previous thread
    obj.name = name or "unnamed_channed_"..math.random(1,100) -- Name of the channel
    obj._state = "paused"
    setmetatable(obj, self)
    self.__index = self
    return obj
end

function FakeChannel:push(value)
    if self.name == "save_request" and value == "done" then
        return
    end
    if WEB_DEBUG_CHANNELS then print("Pushing value to channel: ", value.type .. " - " .. self.name) end
    table.insert(self.queue, value)
    if self._thread and coroutine.status(self._thread) == "suspended" then
        coroutine.resume(self._thread) -- Resume the previous thread when a value is pushed
    end
end

function FakeChannel:pop()
    if WEB_DEBUG_CHANNELS then print("Popping value from channel" .. " - " .. self.name) end
    return table.remove(self.queue, 1)
end

function FakeChannel:demand()
    while #self.queue == 0 do
        coroutine.yield() -- Yield until a value is pushed
        if WEB_DEBUG_CHANNELS then print("Channel" .. self.name .. " received data.") end
    end
    return self:pop()
end

love.thread.newThread = function(path)
    -- Replace threads with coroutines

    local f = loadstring("local arg = nil\\n"..love.filesystem.read(path))

    local thread = coroutine.create(f)

    prevthread = FakeThread:new(thread)

    return prevthread
end

-- Also replace channels
local channels = {}
love.thread.getChannel = function(name)
    if not channels[name] then
        channels[name] = FakeChannel:new(name)
    end
    return channels[name]
end

-- Fix Log
local _log = math.log
math.log = function(x, base)
  if base then
    return _log(x) / _log(base)
  end
  return _log(x)
end

-- Patch load for smods
-- btw, mod support is pretty nonexistent
load = loadstring`,
// -------------------------------------------------------------------------------
  "nativefs.lua": `-- Web stand-in for the 'nativefs' module that Steamodded and other mods use to
-- reach outside LOVE's sandbox. A browser has no real filesystem to reach, so
-- every call is mapped onto love.filesystem instead: reads resolve against the
-- fused .love archive (shadowed by the save directory) and writes land in the
-- save directory.
--
-- Paths arriving here can be relative, absolute (mods happily pass
-- love.filesystem.getSaveDirectory() around) or redirected through a mounted
-- archive, so everything goes through resolve() first.

local nativefs = {}

local save_dir = love.filesystem.getSaveDirectory and love.filesystem.getSaveDirectory() or ""
local source_dir = love.filesystem.getSource and love.filesystem.getSource() or ""

local function slashes(path)
    return (tostring(path or ""):gsub("\\\\", "/"))
end

-- Collapse '.', '..' and repeated slashes, and drop any leading slash.
local function normalize(path)
    local parts = {}
    for part in slashes(path):gmatch("[^/]+") do
        if part == ".." then
            if #parts > 0 then table.remove(parts) end
        elseif part ~= "." then
            parts[#parts + 1] = part
        end
    end
    return table.concat(parts, "/")
end

local redirects = {}

-- Steamodded registers redirects so a mounted archive can be read through a
-- path that looks like a plain directory.
function nativefs.smodsAddRedirect(realPath, lfsPath)
    realPath = slashes(realPath)
    if redirects[realPath] then
        return false, 'A redirect with path "' .. realPath .. '" already exists'
    end
    redirects[realPath] = slashes(lfsPath)
    return true
end

local function applyRedirect(path)
    for from, to in pairs(redirects) do
        if path == from then return to end
        if path:sub(1, #from + 1) == from .. "/" then
            return to .. "/" .. path:sub(#from + 2)
        end
    end
    return nil
end

local function stripRoot(path)
    for _, root in ipairs({ slashes(save_dir), slashes(source_dir) }) do
        if root ~= "" then
            if path == root then return "" end
            if path:sub(1, #root + 1) == root .. "/" then return path:sub(#root + 2) end
        end
    end
    return path
end

nativefs.workingDirectory = ""

local function resolve(path)
    path = slashes(path)
    local redirected = applyRedirect(path)
    if redirected then return normalize(redirected) end
    local absolute = path:sub(1, 1) == "/" or path:match("^%a:") ~= nil
    if not absolute and nativefs.workingDirectory ~= "" then
        path = slashes(nativefs.workingDirectory) .. "/" .. path
    end
    return normalize(stripRoot(path))
end

nativefs.resolve = resolve

local function ensureParent(path)
    local dir = path:match("^(.*)/[^/]*$")
    if dir and dir ~= "" and not love.filesystem.getInfo(dir) then
        love.filesystem.createDirectory(dir)
    end
end

function nativefs.read(a, b, c)
    if type(b) == "string" then -- read(container, name, size)
        return love.filesystem.read(a, resolve(b), c)
    end
    local path = resolve(a)
    if not love.filesystem.getInfo(path) then
        return nil, "Could not open file " .. tostring(a) .. ": does not exist"
    end
    return love.filesystem.read(path, b)
end

function nativefs.write(path, data, size)
    local resolved = resolve(path)
    ensureParent(resolved)
    return love.filesystem.write(resolved, data, size)
end

function nativefs.append(path, data, size)
    local resolved = resolve(path)
    ensureParent(resolved)
    return love.filesystem.append(resolved, data, size)
end

function nativefs.getInfo(path, a, b)
    return love.filesystem.getInfo(resolve(path), a, b)
end

function nativefs.exists(path)
    return love.filesystem.getInfo(resolve(path)) ~= nil
end

function nativefs.getDirectoryItems(path)
    return love.filesystem.getDirectoryItems(resolve(path))
end

function nativefs.getDirectoryItemsInfo(path, filtertype)
    local out = {}
    local base = slashes(path):gsub("/$", "")
    for _, name in ipairs(nativefs.getDirectoryItems(base)) do
        local info = nativefs.getInfo(base .. "/" .. name)
        if info and (not filtertype or info.type == filtertype) then
            info.name = name
            out[#out + 1] = info
        end
    end
    return out
end

function nativefs.createDirectory(path)
    return love.filesystem.createDirectory(resolve(path))
end

nativefs.mkdir = nativefs.createDirectory

function nativefs.remove(path)
    return love.filesystem.remove(resolve(path))
end

-- nativefs reports a missing file by returning nil plus a message, while
-- love.filesystem raises. Callers branch on the nil - Steamodded uses it to fall
-- back from a 2x asset to a 1x one - so the difference matters.
local function missing(path)
    return nil, "Could not open file " .. tostring(path) .. ": does not exist"
end

function nativefs.newFile(path, mode)
    local resolved = resolve(path)
    local ok, file, err = pcall(love.filesystem.newFile, resolved, mode)
    if not ok then return nil, tostring(file) end
    if not file then return nil, err end
    return file
end

function nativefs.newFileData(a, b)
    if type(b) == "string" then -- newFileData(contents, name)
        return love.filesystem.newFileData(a, b)
    end
    local path = resolve(a)
    if not love.filesystem.getInfo(path) then return missing(a) end
    local ok, data, err = pcall(love.filesystem.newFileData, path)
    if not ok then return nil, tostring(data) end
    if not data then return nil, err end
    return data
end

function nativefs.load(path)
    local contents, err = nativefs.read(path)
    if not contents then return nil, err end
    return load(contents, "@" .. slashes(path))
end

function nativefs.mount(archive, mountpoint, append)
    return love.filesystem.mount(resolve(archive), mountpoint, append)
end

function nativefs.unmount(archive)
    return love.filesystem.unmount(resolve(archive))
end

function nativefs.setWorkingDirectory(path)
    path = slashes(path)
    local absolute = path:sub(1, 1) == "/" or path:match("^%a:") ~= nil
    if absolute or nativefs.workingDirectory == "" then
        nativefs.workingDirectory = path
    else
        nativefs.workingDirectory = nativefs.workingDirectory .. "/" .. path
    end
    return true
end

function nativefs.getWorkingDirectory()
    return nativefs.workingDirectory
end

function nativefs.getDriveList()
    return {}
end

-- Mods build asset paths by concatenation and rely on this to fix up casing.
function nativefs.getNormalizedPath(path)
    path = slashes(path)
    if nativefs.getInfo(path) then return path end
    local trimmed = path:gsub("/$", "")
    local parent = trimmed:match("^(.*)/[^/]*$")
    if not parent or parent == "" then return path end
    local parent_dir = nativefs.getNormalizedPath(parent)
    for _, name in ipairs(nativefs.getDirectoryItems(parent_dir) or {}) do
        if (parent_dir .. "/" .. name):lower() == trimmed:lower() then
            return parent_dir .. "/" .. name
        end
    end
    return path
end

function nativefs.lines(path)
    local content = nativefs.read(path)
    local i = 1
    return function()
        if not content or i > #content then return nil end
        local next_newline = content:find("\\n", i, true)
        if not next_newline then
            local line = content:sub(i)
            i = #content + 1
            return line
        end
        local line = content:sub(i, next_newline - 1)
        i = next_newline + 1
        return (line:gsub("\\r$", ""))
    end
end

return nativefs`,
// -------------------------------------------------------------------------------
  "lovely.lua": `-- Stand-in for the module the Lovely injector exposes to Lua.
--
-- Lovely patches the game as it loads, but this build applies every patch to
-- the source archive ahead of time, so the runtime half of its API is reduced
-- to something mods can call without crashing:
--   * reload_patches() succeeds without doing anything - the patches a reload
--     would re-apply are already baked into the archive
--   * apply_patches() hands back the buffer it was given, so mods that run
--     their own files through it keep working (unpatched)
--   * the variable store is real, but only lives for the current page

local lovely = {}

lovely.version = "0.9.0-web"
lovely.mod_dir = "Mods/"
lovely.is_web = true
lovely.patch_dir = "Mods/"

local vars = {}

function lovely.set_var(key, value)
    vars[tostring(key)] = tostring(value)
    return true
end

function lovely.get_var(key)
    return vars[tostring(key)]
end

function lovely.remove_var(key)
    local previous = vars[tostring(key)]
    vars[tostring(key)] = nil
    return previous
end

function lovely.reload_patches()
    print("lovely.reload_patches(): patches are applied when the version is built; ignoring.")
    return true
end

function lovely.apply_patches(name, buffer)
    return buffer
end

return lovely`
}

/**
 * Extra files written only when a Steamodded-style mod is present.
 *
 * Steamodded injects these module names itself, from sources that need LuaJIT's
 * FFI to talk to libcurl. Nothing in a browser can load a native library, so
 * they are replaced with stubs that report failure instead of erroring at
 * require time.
 */
window.smodsPatches = {
    "https.lua": `-- love's https module is not built into love.js.
return {
    request = function(url)
        print("https.request('" .. tostring(url) .. "'): not available in the web build")
        return 0, "HTTPS requests are not available in the web build", {}
    end,
}`,
// -------------------------------------------------------------------------------
    "luajit-curl.lua": `-- Steamodded's libcurl binding needs LuaJIT's FFI, which love.js does not have.
return setmetatable({}, {
    __index = function()
        error("libcurl is not available in the web build", 2)
    end,
})`,
// -------------------------------------------------------------------------------
    "SMODS/nativefs.lua": `-- Steamodded registers its nativefs twice, under 'nativefs' and under
-- 'SMODS.nativefs', so that a mod vendoring its own copy cannot replace the one
-- Steamodded itself uses. Both names resolve to the web version.
return require("nativefs")`,
// -------------------------------------------------------------------------------
    "SMODS/https.lua": `-- Replaces Steamodded's threaded libcurl client.
local M = {}

local function unavailable(url)
    print("SMODS.https: request to '" .. tostring(url) .. "' skipped (no HTTPS in the web build)")
    return 0, "HTTPS requests are not available in the web build", {}
end

function M.request(url)
    return unavailable(url)
end

function M.asyncRequest(url, options, cb)
    if type(options) == "function" and not cb then
        cb = options
    end
    local code, body, headers = unavailable(url)
    if type(cb) == "function" then cb(code, body, headers) end
end

M.threads = {}

return M`
}
/**
 * Turns Balatro.exe (or a .love) plus a set of mod folders into a patched
 * .love archive that love.js can run.
 *
 * Mods are applied the way the Lovely injector would (see lovely.js), with two
 * extra passes that native Balatro does not need:
 *
 *   - module patches become real files in the archive, because there is no
 *     loadbuffer hook to inject them through
 *   - every .lua file is run through the Lua 5.1 transform (see lua51.js),
 *     because love.js ships Lua 5.1 rather than LuaJIT
 */

/** Mod name used for the output of Lovely's own `dump` directory. */
const LOVELY_DUMP = "Dump from Lovely"

/**
 * Bump this whenever the patches guarded by the `web_patched` marker change.
 *
 * Builds are usually made from the cached "vanilla" build rather than from
 * Balatro.exe, and that cached copy is itself an output of this function, so it
 * already carries the marker. While the marker was a bare boolean, a vanilla
 * cached by an older version of this file skipped the whole patch block
 * forever - including patches added since. That is not theoretical: a vanilla
 * cached before the sound-manager stub existed still had `F_SOUND_THREAD`
 * turned off but no `G.SOUND_MANAGER`, so Steamodded's `SMODS.Sound:inject()`
 * died on `G.SOUND_MANAGER.channel` and took the game down at boot.
 *
 * Storing the revision instead means such a build re-patches itself.
 */
const PATCH_REVISION = "2"

/** LuaJIT's FFI, which love.js has no equivalent for. */
const NEEDS_FFI = /require *\(? *["']ffi["']|\bffi\.(cdef|load|typeof|metatype)\b/

/**
 * Hands control back to the browser for a tick. A big content mod (Ortalab
 * and Cryptid both ship hundreds of files) means hundreds of synchronous
 * tokenize/patch passes back to back; without an occasional yield the tab
 * can look hung on a slow device even though it is still working.
 *
 * @returns {Promise<void>}
 */
function yieldToUI() {
    return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * @param {number} everyN Yield after this many calls
 * @returns {() => Promise<void>}
 */
function makeYielder(everyN) {
    let count = 0
    return async function maybeYield() {
        count++
        if (count % everyN === 0) await yieldToUI()
    }
}

/**
 * @param {Blob | File} blob .zip or .exe of balatro
 * @param {Object<string, Object>} mods Nested object of mods
 * @param {{performanceMode?: boolean}} [options]
 * @returns {Promise<Blob>} .zip of patched source
 */
async function buildFromSource(blob, mods, options) {
    options = options || {}
    const performanceMode = !!options.performanceMode
    // Yield more often in performance mode: a slower device benefits more
    // from staying responsive than from the build finishing a bit sooner.
    const maybeYield = makeYielder(performanceMode ? 5 : 25)

    const progress_bar = $("progressBar")
    const status_text = $("status")

    /** @type {string[]} Everything worth telling the user about afterwards. */
    const report = []

    function note(message) {
        report.push(message)
        console.warn("[build] " + message)
    }

    progress_bar.value = "0"
    status_text.innerText = "Finding Source"

    const buffer = await blob.arrayBuffer()
    const reader = new BufferReader(buffer)

    // Search for "PK\x03\x04"
    // Not many ways to do this better.
    // Works for .zip archives bc they start with PK\3\4
    while (true) {
        if (reader.string(4) === "PK\x03\x04") break
        reader.step(-3)
    }

    progress_bar.value = "20"
    reader.step(-4)
    const pkfile = reader.bytes(reader.view.byteLength - reader.offset)

    status_text.innerText = "Extracting zip"
    const zipfile = await JSZip.loadAsync(pkfile)

    if (!zipfile.file("main.lua")) {
        throw new Error("That file does not contain Balatro's source (no main.lua was found).")
    }

    /**
     * @param {string} path A file path inside the archive
     * @returns {Promise<string|null>} Contents of the file, or null if missing
     */
    function get_file(path) {
        const entry = zipfile.file(path)
        if (!entry) return Promise.resolve(null)
        return entry.async("string")
    }

    /**
     * @param {string} path Path to file
     * @param {string} data Contents of file
     */
    function set_file(path, data) {
        zipfile.file(path, data)
    }

    /**
     * @param {string} mod Mod name
     * @param {string} path Path of a file inside that mod
     * @returns {Promise<string>} Contents of the file
     */
    function get_mod_file(mod, path) {
        let current = mods[mod]
        for (const chunk of path.split("\\").join("/").split("/")) {
            if (!current) break
            current = current[chunk]
        }
        if (!current || !(current instanceof File)) {
            return Promise.reject(new Error("mod '" + mod + "' has no file '" + path + "'"))
        }
        return current.text()
    }

    // Replace source with patched data from an external Lovely run.
    function parseLovelyDump(obj, path) {
        for (const [name, value] of Object.entries(obj)) {
            if (!(value instanceof File)) {
                parseLovelyDump(value, path + name + "/")
                continue
            }
            set_file(path + name, value)
        }
    }

    if (mods[LOVELY_DUMP]) {
        status_text.innerText = "Applying Lovely dump"
        parseLovelyDump(mods[LOVELY_DUMP], "")
    }

    progress_bar.value = "30"
    status_text.innerText = "Reading mod patches"

    /** Files that came from the game itself, for spotting collisions later. */
    const game_files = new Set(Object.keys(zipfile.files))

    const patch_set = new Lovely.LovelyPatchSet()
    const mod_names = Object.keys(mods).filter((name) => name !== LOVELY_DUMP).sort()

    for (const name of mod_names) {
        const mod = mods[name]
        // The dump already contains this mod's edits to the game's own files,
        // so only its injected modules are still needed.
        const dump_covers_it = !!mod["dont_patch.txt"]
        const set = dump_covers_it ? new Lovely.LovelyPatchSet() : patch_set

        for (const toml_file of collectModTomls(mod)) {
            const text = await toml_file.file.text()
            set.addPatchFile(name, toml_file.path, text, "Mods/" + name)
        }

        if (dump_covers_it) {
            // Keep the module patches, drop the file edits.
            for (const entry of set.entries) {
                if (entry.kind !== "module") continue
                entry.seq = patch_set.seq++
                patch_set.entries.push(entry)
            }
            patch_set.warnings.push.apply(patch_set.warnings, set.warnings)
        }
    }

    report.push.apply(report, patch_set.warnings)
    patch_set.warnings.length = 0

    const metadata = await inspectMods(mods, mod_names)
    const steamodded = metadata.provides_steamodded ||
        patch_set.ofKind("module").some((entry) => String(entry.data.name || "").startsWith("SMODS."))

    if (!steamodded && metadata.needs_steamodded.length) {
        note("these mods need Steamodded, which was not added to this build: " +
            metadata.needs_steamodded.join(", "))
    }
    for (const message of metadata.missing_dependencies) note(message)

    // --- module patches -----------------------------------------------------
    // Lovely injects these into package.preload. Here they become files, which
    // `require` finds through love.filesystem, and anything flagged `load_now`
    // additionally gets a require prepended to the file it must precede.
    status_text.innerText = "Injecting mod modules"

    /** @type {Object<string, string>} Module name -> path in the archive */
    const module_files = {}
    /** @type {Object<string, string[]>} Target file -> module names to require first */
    const requires_before = {}

    for (const entry of patch_set.ofKind("module")) {
        const patch = entry.data
        if (!patch.name || !patch.source) {
            note(entry.label + ": module patch is missing a name or source")
            continue
        }
        const path = String(patch.name).split(".").join("/") + ".lua"
        if (game_files.has(path)) {
            // Lovely shadows modules through package.preload; here they are real
            // files, so one named after a game file would replace it.
            note(entry.label + ": module '" + patch.name + "' overwrites the game's own " + path)
        }
        let module_source
        try {
            module_source = await get_mod_file(entry.mod, String(patch.source))
            set_file(path, module_source)
        } catch (err) {
            note(entry.label + ": " + err.message)
            continue
        }
        module_files[patch.name] = path
        if (window.patches[path] || (steamodded && window.smodsPatches[path])) {
            note(entry.label + ": module '" + patch.name +
                "' needs native code, so the web version of it is used instead")
        } else if (NEEDS_FFI.test(module_source)) {
            // Mods usually bundle `nativefs` under a name this build replaces,
            // but one injected under a name of its own keeps its LuaJIT code.
            // That is only fatal once something requires it - many mods reach
            // for their own copy only when Steamodded is absent - so report it
            // rather than failing the build.
            note(entry.label + ": module '" + patch.name + "' needs LuaJIT's FFI, which love.js does not have. " +
                "It will error if the mod requires it rather than Steamodded's file system.")
        }
        if (patch.load_now && patch.before) {
            requires_before[patch.before] = requires_before[patch.before] || []
            requires_before[patch.before].push(patch.name)
        }
        await maybeYield()
    }

    // --- copy sources -------------------------------------------------------
    /** @type {Map<Object, string[]>} */
    const copy_contents = new Map()
    for (const entry of patch_set.ofKind("copy")) {
        const sources = []
        for (const source of entry.data.sources || []) {
            try {
                sources.push(await get_mod_file(entry.mod, String(source)))
            } catch (err) {
                note(entry.label + ": " + err.message)
            }
        }
        copy_contents.set(entry, sources)
        await maybeYield()
    }

    /**
     * Patches may target a file in the game, the chunk name of a module another
     * patch injected (`=[lovely <name> "<source>"]`), or a shader.
     *
     * Shaders never pass through Lua's loader, so Lovely patches them through a
     * `love.graphics.newShader` hook that names them by bare file name. There is
     * no hook here, so the file itself is patched instead - which matters on the
     * web, since several of those patches are OpenGL ES fixes and WebGL is
     * OpenGL ES.
     */
    function target_to_path(target) {
        const module = /^=\[lovely (\S+) "[^"]*"\]$/.exec(target)
        if (module) return module_files[module[1]] || null
        if (zipfile.file(target)) return target
        if (target.indexOf("/") === -1 && /\.(fs|vs|glsl)$/i.test(target)) {
            const shader = "resources/shaders/" + target
            if (zipfile.file(shader)) return shader
        }
        return target
    }

    // --- pattern / regex / copy patches -------------------------------------
    const targets = Array.from(patch_set.targets()).sort()
    let patched_files = 0
    let applied_patches = 0

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i]
        progress_bar.value = String(30 + Math.round((i / Math.max(targets.length, 1)) * 35))
        status_text.innerText = "Patching " + target

        const path = target_to_path(target)
        if (!path) {
            note("no module provides the patch target '" + target + "'")
            continue
        }
        const contents = await get_file(path)
        if (contents === null) {
            note("patch target '" + target + "' is not part of this game build; skipped")
            continue
        }

        const result = patch_set.applyTo(target, contents, (entry) => copy_contents.get(entry) || [])
        set_file(path, result.content)
        if (result.applied) patched_files++
        applied_patches += result.applied
        report.push.apply(report, result.warnings)
        await maybeYield()
    }

    // --- mod files ----------------------------------------------------------
    progress_bar.value = "65"
    status_text.innerText = "Copying mods"

    function move_dir(dir, path) {
        for (const [name, file] of Object.entries(dir)) {
            if (!(file instanceof File)) {
                zipfile.folder(path + name)
                move_dir(file, path + name + "/")
            } else {
                zipfile.file(path + name, file)
            }
        }
    }

    const mods_without_dump = {}
    for (const name of mod_names) mods_without_dump[name] = mods[name]
    move_dir(mods_without_dump, "Mods/")

    // --- web compatibility --------------------------------------------------
    progress_bar.value = "70"
    status_text.innerText = "Applying Patches"

    for (const patch_file of Object.keys(window.patches)) {
        zipfile.file(patch_file, window.patches[patch_file])
    }
    if (steamodded) {
        for (const patch_file of Object.keys(window.smodsPatches)) {
            zipfile.file(patch_file, window.smodsPatches[patch_file])
        }
    }

    // The marker records which revision of the patches below this source was
    // built with, so a source patched by an older version of this file gets
    // brought up to date instead of being left as it is. A Lovely dump
    // overwrites game files wholesale, so that forces a re-patch too.
    //
    // Every step below is written to be safe to run again over a source that
    // already carries some or all of these patches.
    const marker = zipfile.file("web_patched")
    const baked_revision = marker === null ? null : (await marker.async("string")).trim()
    if (baked_revision !== PATCH_REVISION || mods[LOVELY_DUMP]) {
        {
            let contents = await get_file("main.lua")
            if (contents.indexOf('require "web_patches"') === -1) {
                contents = 'require "web_patches"\n' + contents
            }
            contents = contents.replace("if os == 'OS X' or os == 'Windows' then", "if false then")
            set_file("main.lua", contents)
        }

        progress_bar.value = "73"

        {
            const contents = await get_file("globals.lua")
            set_file("globals.lua", contents.replace("F_SOUND_THREAD = true", "F_SOUND_THREAD = false"))
        }

        {
            // Without the sound thread the game never builds a sound manager, so
            // stand one in. It has to exist before the end of Game:start_up(),
            // because that is where mod loaders hook in and mods register sounds
            // through it.
            const contents = await get_file("game.lua")
            const signature = "if not G.F_SOUND_THREAD then self.SOUND_MANAGER ="
            const stub = signature +
                " { channel = { push = function() end }, load_channel = { push = function() end, pop = function() end } } end\n    "
            if (contents.indexOf(signature) !== -1) {
                // An earlier pass over this source already stood one in.
            } else if (contents.indexOf("if G.F_SOUND_THREAD then") === -1) {
                note("could not find the sound thread check in game.lua, so no sound manager was stood in: " +
                    "Steamodded crashes at boot on a nil G.SOUND_MANAGER. This build of Balatro may be too new.")
            } else {
                set_file("game.lua", contents.replace("if G.F_SOUND_THREAD then", stub + "if G.F_SOUND_THREAD then"))
            }
        }

        progress_bar.value = "76"

        {
            const path = "resources/shaders/hologram.fs"
            const contents = await get_file(path)
            if (contents === null) note("could not find " + path + " to patch")
            else set_file(path, contents.replace(/glow_samples;/g, "4;"))
        }

        zipfile.file("web_patched", PATCH_REVISION)
    }

    // The "optimize for slower devices" choice is independent of the patch
    // revision above - it can be flipped on an already-patched build without
    // forcing a full re-patch - so it is written (or cleared) unconditionally.
    if (performanceMode) {
        zipfile.file("web_perf_mode", "true")
    } else {
        zipfile.remove("web_perf_mode")
    }

    // Prepended last so they still land after `require "web_patches"`, which
    // has to run before any mod code touches the love API.
    for (const [target, module_names] of Object.entries(requires_before)) {
        const path = target_to_path(target)
        const contents = path === null ? null : await get_file(path)
        if (contents === null) {
            note("cannot load modules before '" + target + "': no such file in this build")
            continue
        }
        set_file(path, prepend_requires(contents, module_names))
    }

    // --- Lua 5.1 transform --------------------------------------------------
    progress_bar.value = "80"
    status_text.innerText = "Converting to Lua 5.1"

    let transformed = 0
    const lua_files = []
    zipfile.forEach(function (relativePath, file) {
        if (!file.dir && relativePath.toLowerCase().endsWith(".lua")) lua_files.push(relativePath)
    })

    for (let i = 0; i < lua_files.length; i++) {
        const path = lua_files[i]
        progress_bar.value = String(80 + Math.round((i / Math.max(lua_files.length, 1)) * 10))
        status_text.innerText = "Converting to Lua 5.1 (" + (i + 1) + "/" + lua_files.length + ")"

        const contents = await get_file(path)
        if (contents === null || !Lua51.needsTransform(contents)) {
            await maybeYield()
            continue
        }
        const result = Lua51.transform(contents, path)
        report.push.apply(report, result.warnings)
        if (result.changed) {
            set_file(path, result.code)
            transformed++
        }
        await maybeYield()
    }

    // --- done ---------------------------------------------------------------
    progress_bar.value = "90"
    status_text.innerText = "Zipping zip"

    const summary = []
    if (mod_names.length) {
        summary.push(applied_patches + " patches applied across " + patched_files + " files")
    }
    if (transformed) summary.push(transformed + " file(s) converted for Lua 5.1")
    if (steamodded) summary.push("Steamodded support enabled")
    if (performanceMode) summary.push("optimized for slower devices")

    const game = await zipfile.generateAsync({ type: "blob" })
    progress_bar.value = "100"
    status_text.innerText = "Done"

    showBuildReport(summary, report)

    return game
}

/**
 * Lovely reads `lovely.toml` first, then every .toml under `lovely/`, ordered
 * by file name.
 *
 * @param {Object} mod A mod, as a nested object of File values
 * @returns {Array<{path: string, file: File}>}
 */
function collectModTomls(mod) {
    const out = []
    if (mod["lovely.toml"] instanceof File) {
        out.push({ path: "lovely.toml", file: mod["lovely.toml"] })
    }

    const found = []
    function walk(dir, prefix) {
        for (const [name, value] of Object.entries(dir)) {
            if (value instanceof File) {
                if (name.toLowerCase().endsWith(".toml")) found.push({ path: prefix + name, file: value, name: name })
            } else if (value) {
                walk(value, prefix + name + "/")
            }
        }
    }
    if (mod["lovely"] && !(mod["lovely"] instanceof File)) walk(mod["lovely"], "lovely/")

    found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.path < b.path ? -1 : 1)))
    return out.concat(found.map((f) => ({ path: f.path, file: f.file })))
}

/**
 * A mod's `dependencies` entries look like `"Amulet (>=2.7)"`; only the bare
 * id at the front is needed to check whether something provides it.
 *
 * @param {string} dependency
 * @returns {string|null}
 */
function dependencyId(dependency) {
    const match = /^[^\s(]+/.exec(String(dependency))
    return match ? match[0] : null
}

/**
 * Read the metadata JSON that Steamodded mods ship, so the build can say
 * whether Steamodded itself is present, which mods are waiting on it, and
 * which mods declare a dependency on some other mod (e.g. Cryptid needs
 * Amulet) that was not added to this build either.
 *
 * @param {Object<string, Object>} mods
 * @param {string[]} mod_names
 * @returns {Promise<{provides_steamodded: boolean, needs_steamodded: string[], missing_dependencies: string[]}>}
 */
async function inspectMods(mods, mod_names) {
    let provides_steamodded = false
    const needs_steamodded = []
    /** Ids a mod can be referred to by: its own id/name/`provides` entries, and its folder name. */
    const provided_ids = new Set()
    /** @type {Object<string, string[]>} Mod name -> ids of the (non-Steamodded) mods it declares needing. */
    const declared_dependencies = {}

    for (const name of mod_names) {
        let dependent = false
        const deps = []
        provided_ids.add(name.toLowerCase())

        for (const [file_name, file] of Object.entries(mods[name])) {
            if (!(file instanceof File)) continue
            const lower = file_name.toLowerCase()

            if (lower.endsWith(".json")) {
                let meta
                try {
                    meta = JSON.parse(await file.text())
                } catch (err) {
                    continue
                }
                if (!meta || typeof meta !== "object") continue
                if (/steamodded/i.test(String(meta.name || "")) || String(meta.id) === "Steamodded") {
                    provides_steamodded = true
                }
                if (meta.id) provided_ids.add(String(meta.id).toLowerCase())
                for (const provided of [].concat(meta.provides || [])) {
                    provided_ids.add(String(provided).toLowerCase())
                }
                // A Steamodded mod is identified by its metadata JSON;
                // `main_file` is the field Steamodded itself requires.
                if (meta.main_file) dependent = true
                for (const dependency of meta.dependencies || []) {
                    if (/^(smods|steamodded)/i.test(String(dependency))) {
                        dependent = true
                    } else {
                        const id = dependencyId(dependency)
                        if (id) deps.push(id)
                    }
                }
                for (const dependency of meta.conflicts || []) {
                    if (/^(smods|steamodded)/i.test(String(dependency))) dependent = true
                }
            } else if (lower.endsWith(".lua")) {
                // Older mods declare themselves in a comment header instead.
                const head = (await file.text()).slice(0, 2048)
                if (/^---\s*STEAMODDED HEADER/m.test(head)) dependent = true
            }
        }
        if (dependent) needs_steamodded.push(name)
        if (deps.length) declared_dependencies[name] = deps
    }

    const missing_dependencies = []
    for (const [name, deps] of Object.entries(declared_dependencies)) {
        for (const id of deps) {
            if (!provided_ids.has(id.toLowerCase())) {
                missing_dependencies.push(name + " needs '" + id + "', which was not added to this build")
            }
        }
    }

    return {
        provides_steamodded: provides_steamodded,
        needs_steamodded: needs_steamodded,
        missing_dependencies: missing_dependencies
    }
}

/**
 * Put `require` calls at the top of a file, after `require "web_patches"` when
 * that is already there.
 *
 * @param {string} contents
 * @param {string[]} module_names
 * @returns {string}
 */
function prepend_requires(contents, module_names) {
    if (!module_names.length) return contents
    const lines = module_names.map((name) => 'require "' + name + '"').join("\n") + "\n"
    const first = 'require "web_patches"'
    if (contents.startsWith(first)) {
        const newline = contents.indexOf("\n")
        const cut = newline === -1 ? contents.length : newline + 1
        return contents.slice(0, cut) + lines + contents.slice(cut)
    }
    return lines + contents
}

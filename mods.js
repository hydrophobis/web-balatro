/**
 * Does this directory look like a Balatro mod?
 *
 * @param {FileSystemDirectoryHandle} dir
 * @returns {Promise<boolean>}
 */
async function isMod(dir) {
    const knownFiles = [
        "lovely.toml",
        "manifest.json",
        "header.json",
        "metadata.json",
        "main.lua",
        dir.name + ".lua"
    ];
    for (const filename of knownFiles) {
        try {
            await dir.getFileHandle(filename);
            return true;
        } catch {}
    }
    try {
        await dir.getDirectoryHandle("lovely");
        return true;
    } catch {}

    try {
        for await (const [path, obj] of dir.entries()) {
            if (obj.kind === "file" && path.toLowerCase().endsWith(".lua")) {
                return true;
            }
        }
    } catch {}

    return false;
}

/**
 *
 * @param {FileSystemDirectoryHandle} dir
 * @returns {Promise<Object>}
 */
async function directoryToObject(dir) {
    const object = {}
    for await (const [path, obj] of dir.entries()) {
        if (obj.kind == "directory") {
            object[path] = await directoryToObject(obj)
        } else {
            object[path] = await obj.getFile()
        }
    }
    return object
}

/** Pre-patched Lovely dump for the current session only. */
let lovelyDump = null
const dumpedMods = new Set()

/** @type {Object<string, {name: string, label: string, size: number, files: Array<[string, File]>}>} */
let library = {}
let selected = new Set()

/**
 * Work out what kind of mod this is, so the list can say how it will be built
 * instead of warning about every mod that lacks a `webcompatible` marker.
 *
 * @param {Object} mod A mod as a nested object of File values
 * @returns {Promise<{kind: string, label: string}>}
 */
async function classifyMod(mod) {
    if (mod["webcompatible"] instanceof File) {
        return { kind: "web", label: "marked web compatible" }
    }

    for (const [name, file] of Object.entries(mod)) {
        if (!(file instanceof File)) continue
        const lower = name.toLowerCase()
        if (lower.endsWith(".json")) {
            try {
                const meta = JSON.parse(await file.text())
                if (meta && /steamodded/i.test(String(meta.name || ""))) {
                    return { kind: "smods", label: ("Steamodded " + (meta.version_number || meta.version || "")).trim() }
                }
                if (meta && meta.main_file) {
                    return { kind: "smods-mod", label: "Steamodded mod" }
                }
            } catch {}
        } else if (lower.endsWith(".lua")) {
            const head = (await file.text()).slice(0, 2048)
            if (/^---\s*STEAMODDED HEADER/m.test(head)) {
                return { kind: "smods-mod", label: "Steamodded mod" }
            }
        }
    }

    const hasLovely = mod["lovely.toml"] instanceof File ||
        (mod["lovely"] && !(mod["lovely"] instanceof File))
    if (hasLovely) return { kind: "lovely", label: "Lovely patches" }

    return { kind: "unknown", label: "untested on the web" }
}

async function refreshLibrary() {
    library = {}
    for (const entry of await libraryList()) library[entry.name] = entry

    const stored = readSelection()
    selected = stored ? new Set([...stored].filter((name) => library[name])) : new Set(Object.keys(library))
    renderModsList()
}

/**
 * @param {Object<string, Object>} found Mod name -> nested file tree
 * @returns {Promise<string[]>} Names that were stored, replacing any earlier copy
 */
async function storeMods(found) {
    const names = Object.keys(found)
    for (const name of names) {
        const files = flattenTree(found[name])
        const { label } = await classifyMod(found[name])
        await libraryPut({ name, label, size: totalSize(files), files, added: Date.now() })
        selected.add(name)
    }
    writeSelection(selected)
    await refreshLibrary()
    requestPersistentStorage()
    return names
}

async function addModDir() {
    $("makeName").placeholder = "Modded"

    const dir_picker = await showDirectoryPicker({ mode: "read", startIn: "downloads" })

    const found = {}
    if (await isMod(dir_picker)) {
        found[dir_picker.name] = await directoryToObject(dir_picker)
    } else {
        for await (const [, obj] of dir_picker.entries()) {
            if (obj.kind == "directory") found[obj.name] = await directoryToObject(obj)
        }
    }
    await storeMods(found)
}

async function addModZips(fileList) {
    $("makeName").placeholder = "Modded"

    const found = {}
    for (const file of fileList) Object.assign(found, await modsFromZip(file))
    if (!Object.keys(found).length) {
        showError("No mods found in the selected zip.")
        return
    }
    await storeMods(found)
}

async function replaceMod(name, fileList) {
    const found = {}
    for (const file of fileList) Object.assign(found, await modsFromZip(file))
    const incoming = Object.values(found)
    if (incoming.length !== 1) {
        showError("Pick a zip containing exactly one mod to replace '" + name + "'.")
        return
    }
    const [newName] = Object.keys(found)
    if (newName !== name) {
        await libraryDelete(name)
        selected.delete(name)
        const profileNames = Object.keys(localStorage).filter((key) => key.startsWith(PROFILE_PREFIX))
        for (const key of profileNames) {
            const profile = readProfile(key.slice(PROFILE_PREFIX.length))
            if (profile && profile.mods.includes(name)) {
                profile.mods = profile.mods.map((m) => (m === name ? newName : m))
                writeProfile(key.slice(PROFILE_PREFIX.length), profile)
            }
        }
    }
    await storeMods(found)
}

async function removeMod(name) {
    if (!confirm("Remove '" + name + "' from your mod library?")) return
    await libraryDelete(name)
    selected.delete(name)
    writeSelection(selected)
    await refreshLibrary()
}

function clearSelection() {
    selected = new Set()
    lovelyDump = null
    dumpedMods.clear()
    writeSelection(selected)
    renderModsList()
}

/**
 * @param {string[]} names Mods to include
 * @returns {Object<string, Object>} Nested trees keyed by mod name, ready for the build
 */
function buildModTrees(names) {
    const trees = {}
    for (const name of names) {
        if (!library[name]) continue
        const tree = nestFiles(library[name].files)
        if (dumpedMods.has(name)) {
            tree["dont_patch.txt"] = new File(["true"], "dont_patch.txt", { type: "text/plain" })
        }
        trees[name] = tree
    }
    if (lovelyDump) trees[LOVELY_DUMP] = lovelyDump
    return trees
}

const selectedModNames = () => Object.keys(library).filter((name) => selected.has(name)).sort()

function formatSize(bytes) {
    return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB"
}

function renderModsList() {
    const list = $("mod-list")
    list.innerHTML = ""
    const names = Object.keys(library).sort()

    if (!names.length) {
        const empty = document.createElement("small")
        empty.innerText = "No mods stored yet. Add a folder or zip once and it stays in this browser."
        list.appendChild(empty)
    }

    for (const name of names) {
        const row = document.createElement("div")
        row.className = "mod-row"

        const toggle = document.createElement("input")
        toggle.type = "checkbox"
        toggle.checked = selected.has(name)
        toggle.title = "Include in the next build"
        toggle.onchange = () => {
            if (toggle.checked) selected.add(name)
            else selected.delete(name)
            writeSelection(selected)
        }
        row.appendChild(toggle)

        const title = document.createElement("span")
        title.innerText = name
        row.appendChild(title)

        const detail = document.createElement("small")
        detail.innerText = " (" + library[name].label + ", " + formatSize(library[name].size) + ")"
        row.appendChild(detail)

        if (lovelyDump) {
            const inDump = document.createElement("input")
            inDump.type = "checkbox"
            inDump.checked = dumpedMods.has(name)
            inDump.title = "This mod was part of the provided Lovely dump"
            inDump.onchange = () => {
                if (inDump.checked) dumpedMods.add(name)
                else dumpedMods.delete(name)
            }
            row.appendChild(inDump)
        }

        const replace = document.createElement("button")
        replace.innerText = "Replace"
        replace.onclick = () => pickZips(false, (files) => replaceMod(name, files))
        row.appendChild(replace)

        const remove = document.createElement("button")
        remove.innerText = "Remove"
        remove.onclick = () => removeMod(name)
        row.appendChild(remove)

        list.appendChild(row)
    }
}

function pickZips(multiple, onPick) {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = ".zip,application/zip"
    input.multiple = multiple
    input.onchange = () => {
        if (input.files.length) onPick([...input.files]).catch((err) => showError(err.message || String(err)))
    }
    input.click()
}

async function useLovelyDump() {
    const dir_picker = await showDirectoryPicker({ mode: "read", startIn: "downloads" })

    lovelyDump = await directoryToObject(dir_picker)
    alert("Tick the second checkbox next to each mod that was in the provided dump.")

    renderModsList()
}

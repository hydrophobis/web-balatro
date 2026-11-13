const MOD_DB_NAME = "BalatroModLibrary"
const MOD_STORE = "mods"
const SELECTION_KEY = "webSelectedMods"
const PROFILE_PREFIX = "webProfile:"

function openModDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(MOD_DB_NAME, 1)
        request.onupgradeneeded = () => request.result.createObjectStore(MOD_STORE, { keyPath: "name" })
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

async function modStore(mode, run) {
    const db = await openModDB()
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(MOD_STORE, mode)
            const result = run(tx.objectStore(MOD_STORE))
            tx.oncomplete = () => resolve(result.result)
            tx.onerror = () => reject(tx.error)
            tx.onabort = () => reject(tx.error)
        })
    } finally {
        db.close()
    }
}

const libraryList = () => modStore("readonly", (s) => s.getAll())
const libraryGet = (name) => modStore("readonly", (s) => s.get(name))
const libraryPut = (entry) => modStore("readwrite", (s) => s.put(entry))
const libraryDelete = (name) => modStore("readwrite", (s) => s.delete(name))

async function requestPersistentStorage() {
    try {
        if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist()
    } catch {}
    return false
}

function readSelection() {
    try {
        const stored = localStorage.getItem(SELECTION_KEY)
        return stored === null ? null : new Set(JSON.parse(stored))
    } catch {
        return null
    }
}

function writeSelection(selected) {
    try {
        localStorage.setItem(SELECTION_KEY, JSON.stringify([...selected]))
    } catch {}
}

function readProfile(name) {
    try {
        return JSON.parse(localStorage.getItem(PROFILE_PREFIX + name))
    } catch {
        return null
    }
}

function writeProfile(name, profile) {
    try {
        localStorage.setItem(PROFILE_PREFIX + name, JSON.stringify(profile))
    } catch {}
}

function removeProfile(name) {
    try {
        localStorage.removeItem(PROFILE_PREFIX + name)
    } catch {}
}

/**
 * @param {Object} tree Nested object of File values
 * @param {string} prefix
 * @param {Array<[string, File]>} out
 * @returns {Array<[string, File]>}
 */
function flattenTree(tree, prefix = "", out = []) {
    for (const [name, value] of Object.entries(tree)) {
        if (value instanceof File) out.push([prefix + name, value])
        else flattenTree(value, prefix + name + "/", out)
    }
    return out
}

/**
 * @param {Array<[string, File]>} files
 * @returns {Object} Nested object of File values
 */
function nestFiles(files) {
    const root = {}
    for (const [path, file] of files) {
        const parts = path.split("/")
        let node = root
        for (const part of parts.slice(0, -1)) node = node[part] = node[part] || {}
        node[parts[parts.length - 1]] = file
    }
    return root
}

function totalSize(files) {
    return files.reduce((sum, [, file]) => sum + file.size, 0)
}

function looksLikeMod(tree, name) {
    const known = ["lovely.toml", "manifest.json", "header.json", "metadata.json", "main.lua", name + ".lua"]
    if (known.some((file) => tree[file] instanceof File)) return true
    if (tree["lovely"] && !(tree["lovely"] instanceof File)) return true
    return Object.entries(tree).some(([file, value]) => value instanceof File && file.toLowerCase().endsWith(".lua"))
}

const ZIP_JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/

/**
 * Split a zip into the mods it contains. A zip may hold one mod at its root,
 * one mod inside a single wrapper folder, or several mod folders side by side.
 *
 * @param {File} zipFile
 * @returns {Promise<Object<string, Object>>} Mod name -> nested file tree
 */
async function modsFromZip(zipFile) {
    const zip = await JSZip.loadAsync(zipFile)
    const files = []
    for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir || ZIP_JUNK.test(path)) continue
        const base = path.split("/").pop()
        files.push([path, new File([await entry.async("blob")], base)])
    }
    if (!files.length) return {}

    const archiveName = zipFile.name.replace(/\.zip$/i, "")
    let tree = nestFiles(files)

    const top = Object.keys(tree)
    if (top.length === 1 && !(tree[top[0]] instanceof File)) {
        const inner = tree[top[0]]
        if (looksLikeMod(inner, top[0])) return { [top[0]]: inner }
        tree = inner
    }
    if (looksLikeMod(tree, archiveName)) return { [archiveName]: tree }

    const found = {}
    for (const [name, value] of Object.entries(tree)) {
        if (!(value instanceof File)) found[name] = value
    }
    return found
}

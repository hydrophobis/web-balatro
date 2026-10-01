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

let mods = {}

/** Mod name -> short description of how it will be handled, shown in the list. */
let modLabels = {}

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
            // Older Steamodded mods declare themselves in a comment header.
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

async function addModDir() {
    $("makeName").placeholder = "Modded"

    /** @type {FileSystemDirectoryHandle} */
    const dir_picker = await showDirectoryPicker({
        mode: "read",
        startIn: "downloads"
    });

    const added = []
    if (await isMod(dir_picker)) {
        mods[dir_picker.name] = await directoryToObject(dir_picker)
        added.push(dir_picker.name)
    } else {
        for await (const [path, obj] of dir_picker.entries()) {
            if (obj.kind == "directory") {
                mods[obj.name] = await directoryToObject(obj)
                added.push(obj.name)
            }
        }
    }

    for (const name of added) {
        modLabels[name] = (await classifyMod(mods[name])).label
    }

    renderModsList()
}

function clearMods() {
    mods = {}
    modLabels = {}
    renderModsList()
}

function renderModsList() {
    const list = $("mod-list");
    list.innerHTML = "";
    for (const mod_name of Object.keys(mods)) {
        const mod_item = document.createElement("label");
        mod_item.innerText = mod_name;

        if (modLabels[mod_name]) {
            const label = document.createElement("small");
            label.innerText = " (" + modLabels[mod_name] + ")";
            mod_item.appendChild(label);
        }

        if (mods[LOVELY_DUMP] && mod_name != LOVELY_DUMP) {
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = false;
            checkbox.title = "This mod was part of the provided Lovely dump";
            checkbox.onchange = function() {
                if (checkbox.checked) {
                    mods[mod_name]["dont_patch.txt"] = new File(["true"], "dont_patch.txt", { type: "text/plain" })
                } else {
                    delete mods[mod_name]["dont_patch.txt"]
                }
            }
            mod_item.prepend(checkbox);
        }

        list.appendChild(mod_item);

        list.appendChild(document.createElement("br"));
    }
}

async function useLovelyDump() {
    // Open a folder picker
    const dir_picker = await showDirectoryPicker({
        mode: "read",
        startIn: "downloads"
    });

    mods[LOVELY_DUMP] = await directoryToObject(dir_picker)
    modLabels[LOVELY_DUMP] = "pre-patched game files"

    alert("Click the checkboxes next to the mods that were in provided dump.")

    renderModsList()
}

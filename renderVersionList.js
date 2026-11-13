function $(id) {
    return document.getElementById(id)
}

const make = document.createElement.bind(document)

/**
 * 
 * @param {string[]} versions 
 */
async function renderVersionList() {
    const versions = await listCachedVersions()
    const versionsList = $("versionsList")
    versionsList.innerHTML = ""
    {
        const load_vanilla_radio = $("loadVanillaRadio")
        load_vanilla_radio.disabled = versions.indexOf("vanilla") == -1
    }
    for (const version of versions) {
        const tr = make("tr")

        const name = make("td")
        name.innerText = version
        tr.appendChild(name)

        const profile = readProfile(version)
        const modsCell = make("td")
        modsCell.innerText = profile ? (profile.mods.join(", ") || "no mods") : ""
        tr.appendChild(modsCell)

        const buttons = make("td")

        const loadButton = make("button")
        loadButton.onclick = function() {
            loadVersion(version)
        }
        loadButton.innerText = "Load"
        buttons.appendChild(loadButton)

        if (profile && version !== "vanilla") {
            const rebuildButton = make("button")
            rebuildButton.innerText = "Rebuild"
            rebuildButton.title = "Rebuild with the current mod library. Keeps this version's save."
            rebuildButton.onclick = async function() {
                rebuildButton.disabled = true
                try {
                    await rebuildVersion(version)
                } catch (err) {
                    reportError(err)
                } finally {
                    rebuildButton.disabled = false
                }
            }
            buttons.appendChild(rebuildButton)
        }

        const delButton = make("button")
        delButton.innerText = "Delete"
        delButton.onclick = async function() {
            if (confirm("Delete '" + version + "'?")) {
                await deleteCachedGame(version)
                removeProfile(version)
                await renderVersionList()
            }
        }
        buttons.appendChild(delButton)

        tr.appendChild(buttons)

        versionsList.appendChild(tr)
    }
}
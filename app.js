function $(id) {
    return document.getElementById(id)
}

/**
 * 
 * @param {Blob | File} blob 
 * @returns {Promise<ArrayBuffer>}
 */
function getArrayBufferFromBlob(blob) {
    let resolve, reject, promise = new Promise((res, rej) => {resolve = res; reject = rej});
    const reader = new FileReader();
    reader.onload = function() {
        resolve(reader.result)
    };
    reader.onerror = function() {
        reject()
    }
    reader.readAsArrayBuffer(blob);
    return promise;
}

/**
 * 
 * @param {Blob | File} blob 
 * @returns {Promise<String>}
 */
function getDataURIFromBlob(blob) {
    let resolve, reject, promise = new Promise((res, rej) => {resolve = res; reject = rej});
    const reader = new FileReader();
    reader.onload = function() {
        resolve(reader.result)
    };
    reader.onerror = function() {
        reject()
    }
    reader.readAsDataURL(blob);
    return promise;
}

let cached_games = []

function reportError(err) {
    if (err && err.name === "AbortError") return
    showError(err instanceof Error ? err.message : String(err))
    console.error(err)
}

/**
 * @param {{name: string, source: Blob, modNames: string[], performanceMode: boolean}} job
 */
async function runBuild({ name, source, modNames, performanceMode }) {
    const progress_bar = $("progressBar")
    const status_text = $("status")

    const game = await buildFromSource(source, buildModTrees(modNames), { performanceMode })

    progress_bar.value = "95"
    status_text.innerText = "Saving to Cache"

    await saveGameToCache(game, name)

    try {
        localStorage.setItem("webPerfMode:" + name, performanceMode ? "1" : "0")
    } catch {}
    writeProfile(name, { mods: modNames, performanceMode })

    progress_bar.value = "100"
    status_text.innerText = "Done"
    setTimeout(() => {
        progress_bar.value = "0"
    }, 1000)
}

/**
 * Rebuild a version from its recorded mod list using the current library
 * contents. The version keeps its name, so its save data carries over.
 *
 * @param {string} name
 */
async function rebuildVersion(name) {
    const profile = readProfile(name)
    if (!profile) return
    const source = await loadCachedGame("vanilla")
    if (!source) {
        showError("Rebuilding needs the 'vanilla' version to be cached.")
        return
    }
    const missing = profile.mods.filter((mod) => !library[mod])
    const present = profile.mods.filter((mod) => library[mod])
    if (missing.length && !confirm("These mods are no longer in your library and will be left out: " + missing.join(", ") + ". Rebuild anyway?")) return

    await runBuild({ name, source, modNames: present, performanceMode: !!profile.performanceMode })
    writeProfile(name, { mods: present, performanceMode: !!profile.performanceMode })
    await renderVersionList()
}

/** Messages past this point are only written to the console. */
const MAX_REPORT_LINES = 200

/**
 * Show what the build did, and anything that did not go to plan. Mods are
 * written against one specific game version, so patches that no longer match
 * are normal and worth surfacing without failing the build.
 *
 * @param {string[]} summary One line each, describing what was built
 * @param {string[]} messages Warnings collected while building
 */
function showBuildReport(summary, messages) {
    const container = $("buildReport")
    container.innerHTML = ""

    if (summary.length) {
        const line = document.createElement("p")
        line.innerText = summary.join(" · ")
        container.appendChild(line)
    }

    if (messages.length) {
        const details = document.createElement("details")
        const label = document.createElement("summary")
        label.innerText = messages.length + " build warning" + (messages.length == 1 ? "" : "s")
        details.appendChild(label)

        const list = document.createElement("ul")
        for (const message of messages.slice(0, MAX_REPORT_LINES)) {
            const item = document.createElement("li")
            item.innerText = message
            list.appendChild(item)
        }
        if (messages.length > MAX_REPORT_LINES) {
            const item = document.createElement("li")
            item.innerText = "... and " + (messages.length - MAX_REPORT_LINES) +
                " more, see the browser console"
            list.appendChild(item)
        }
        details.appendChild(list)
        container.appendChild(details)
        console.warn("Build warnings:\n" + messages.join("\n"))
    }

    container.classList.toggle("hidden", !summary.length && !messages.length)
}


document.addEventListener("DOMContentLoaded", async () => {
    const file_input = $("exeInput")

    const load_exe_radio = $("loadExeRadio")
    const load_vanilla_radio = $("loadVanillaRadio")

    const add_mods_button = $("addModDir")
    const clear_mods_button = $("clearMods")
    const use_lovely_dump_button = $("useLovelyDump")

    const version_name_input = $("makeName")
    const perf_mode_checkbox = $("perfMode")

    const build_button = $("parseBtn")

    const progress_bar = $("progressBar")
    const status_text = $("status")



    add_mods_button.onclick = () => addModDir().catch(reportError)
    $("addModZip").onclick = () => pickZips(true, addModZips)
    clear_mods_button.onclick = clearSelection
    use_lovely_dump_button.onclick = () => useLovelyDump().catch(reportError)

    function checkBuildButton() {
        if (file_input.files.length > 0 && load_exe_radio.checked) {
            build_button.disabled = false;
        } else if (load_vanilla_radio.checked) {
            build_button.disabled = false;
        } else {
            build_button.disabled = true;
        }
    }

    file_input.onchange = checkBuildButton
    load_exe_radio.onchange = checkBuildButton
    load_vanilla_radio.onchange = checkBuildButton

    build_button.addEventListener("click", async function() {
        try {
            build_button.disabled = true
            file_input.parentElement.classList.add("disabled")
            file_input.disabled = true;
            version_name_input.disabled = true;
            
            let file;
            if (load_exe_radio.checked) {
                file = file_input.files[0]
                if (!file) throw new Error("No file inputted")
                const name = file.name
            } else {
                file = await loadCachedGame()
            }

            let name = version_name_input.value

            if (!name) {
                showError("No name provided for the build. Aborting.")
                return
            }

            if (selectedModNames().length > 0 || lovelyDump) {
                if (name == "vanilla") {
                    if (!confirm("DANGEROUS! Overwrite the 'vannila' build? This can break subsequent builds using the cached vanilla, but this will also let you create default mods for new versions.")) {
                        return
                    }
                }
            } else {
                if (!name) {
                    version_name_input.value = "vanilla"
                    name = "vanilla"
                }
                if (name != "vanilla") {
                    if (!confirm("Create a new version without mods, which is not called vanilla? This is redundant unless you want more save slots.")) {
                        return
                    }
                }
            }

            await runBuild({
                name,
                source: file,
                modNames: selectedModNames(),
                performanceMode: perf_mode_checkbox.checked,
            })

            build_button.classList.remove("hidden")
            await renderVersionList()
            syncSourceChoice()

        } catch (err) {
            progress_bar.classList.add("hidden")
            showError(err instanceof Error ? err.message : String(err))
            console.error(err)
        } finally {
            build_button.disabled = false
            file_input.parentElement.classList.remove("disabled")
            file_input.disabled = false;
            version_name_input.disabled = false;
        }
    });

    // build_button.addEventListener("click", function() {
    //     var s = document.createElement('script');
    //     s.type = 'text/javascript';
    //     s.src = "single_file.js"; // THICC FILE
    //     s.async = true;
    //     s.onload = async function () {
    //         const game_uri = await getDataURIFromBlob(game)

    //         const zip = new JSZip()
    //         for (const file_name of Object.keys(window.templates)) {
    //             zip.file(file_name, window.templates[file_name].replace("%%DATAURI%%", game_uri))
    //         }
    //         saveAs(await zip.generateAsync({type: "blob"}), "balatro.zip")
    //     };
    //     document.body.appendChild(s);
    // })
    
    function syncSourceChoice() {
        if (!load_vanilla_radio.disabled && file_input.files.length === 0) {
            load_vanilla_radio.checked = true
        }
        checkBuildButton()
    }

    try {
        await refreshLibrary()
        await renderVersionList()
        syncSourceChoice()
        status_text.innerText = "Ready"
    } catch (err) {
        showError(err.message)
    }
})

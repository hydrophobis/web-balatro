/**
 * A build-time implementation of the Lovely patch format.
 *
 * Native Balatro mods are patched by the Lovely injector, which hooks Lua's
 * loadbuffer and rewrites each source file as the game loads it. There is no
 * way to hook loadbuffer in love.js, so instead every patch is applied to the
 * game's source while the .love archive is being assembled.
 *
 * The semantics here follow lovely-injector (crates/lovely-core/src/patch/*):
 *
 *   - targets are matched by exact name, and may be a string or a list
 *   - per target: `copy` patches first, then `pattern` and `regex` patches,
 *     each group ordered by ascending manifest priority
 *   - `{{lovely:var}}` interpolation happens last, over the whole file, using
 *     the vars of every loaded patch file merged together
 *   - `pattern` matches whitespace-trimmed lines with `?`/`*` wildcards
 *   - `regex` runs in multi-line mode with $group interpolation
 *
 * `module` patches are handled by build.js, since they create files rather
 * than edit them.
 */

(function () {
    /** Positions lovely accepts, normalised to lower case. */
    const POSITIONS = { at: "at", before: "before", after: "after" };

    /**
     * TOML allows one or two quote characters immediately before the closing
     * delimiter of a multi-line string, which the bundled TOML parser rejects
     * (this is the `''''` problem the README used to tell users to fix by hand).
     * Rewrite multi-line literal strings into escaped multi-line basic strings,
     * which the parser handles, leaving their contents byte-identical.
     */
    function normalizeTomlStrings(text) {
        // Editors on Windows leave a byte order mark that the parser reads as
        // part of the first key.
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

        let out = "";
        let i = 0;
        const n = text.length;

        function quoteRun(at, q) {
            let k = at;
            while (k < n && text[k] === q) k++;
            return k - at;
        }

        while (i < n) {
            const c = text[i];
            if (c === "#") {
                const nl = text.indexOf("\n", i);
                const end = nl === -1 ? n : nl;
                out += text.slice(i, end);
                i = end;
                continue;
            }
            if (text.startsWith("'''", i)) {
                let j = i + 3;
                let content = null;
                while (j < n) {
                    if (text[j] === "'") {
                        const run = quoteRun(j, "'");
                        if (run >= 3) {
                            content = text.slice(i + 3, j + run - 3);
                            j = j + run;
                            break;
                        }
                        j += run;
                        continue;
                    }
                    j++;
                }
                if (content === null) {
                    out += text.slice(i);
                    break;
                }
                out += '"""' + content.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"""';
                i = j;
                continue;
            }
            if (text.startsWith('"""', i)) {
                let j = i + 3;
                while (j < n) {
                    if (text[j] === "\\") { j += 2; continue; }
                    if (text[j] === '"') {
                        const run = quoteRun(j, '"');
                        if (run >= 3) { j = j + run; break; }
                        j += run;
                        continue;
                    }
                    j++;
                }
                out += text.slice(i, j);
                i = j;
                continue;
            }
            if (c === '"') {
                let j = i + 1;
                while (j < n) {
                    if (text[j] === "\\") { j += 2; continue; }
                    if (text[j] === '"') { j++; break; }
                    if (text[j] === "\n") break;
                    j++;
                }
                out += text.slice(i, j);
                i = j;
                continue;
            }
            if (c === "'") {
                let j = i + 1;
                while (j < n && text[j] !== "'" && text[j] !== "\n") j++;
                if (text[j] === "'") j++;
                out += text.slice(i, j);
                i = j;
                continue;
            }
            out += c;
            i++;
        }
        return out;
    }

    /** `?` matches one character, `*` matches any run. Everything else is literal. */
    function wildmatch(pattern) {
        let re = "^";
        for (const ch of pattern) {
            if (ch === "*") re += "[\\s\\S]*";
            else if (ch === "?") re += "[\\s\\S]";
            else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        return new RegExp(re + "$");
    }

    /** Lines including their terminator, like crop's Rope::raw_lines. */
    function rawLines(text) {
        return text.match(/[^\n]*\n|[^\n]+/g) || [];
    }

    function indentOf(line) {
        const m = /^[ \t]*/.exec(line);
        return m ? m[0] : "";
    }

    /** Prefix every payload line, and guarantee a trailing newline. */
    function buildPayload(payload, prefix) {
        const parts = payload.match(/[^\n]*\n|[^\n]+/g) || [""];
        let out = parts.map((p) => prefix + p).join("");
        if (!payload.endsWith("\n")) out += "\n";
        return out;
    }

    function targetList(target) {
        if (target === undefined || target === null) return [];
        return Array.isArray(target) ? target : [target];
    }

    /**
     * Apply a `pattern` patch.
     * @returns {{content: string, matches: number, warnings: string[]}}
     */
    function applyPatternPatch(content, patch, label) {
        const warnings = [];
        const patternLines = (patch.pattern === undefined ? "" : String(patch.pattern)).split("\n");
        // Rust's str::lines() drops one trailing newline; split("\n") leaves an
        // empty element behind for it.
        if (patternLines.length > 1 && patternLines[patternLines.length - 1] === "") patternLines.pop();
        const matchers = patternLines.map((l) => wildmatch(l.trim()));
        if (!matchers.length) {
            warnings.push(label + ": pattern has no lines");
            return { content: content, matches: 0, warnings: warnings };
        }

        const lines = rawLines(content);
        const offsets = new Array(lines.length + 1);
        let acc = 0;
        for (let i = 0; i < lines.length; i++) { offsets[i] = acc; acc += lines[i].length; }
        offsets[lines.length] = acc;

        const matches = [];
        let i = 0;
        while (i + matchers.length <= lines.length) {
            let hit = true;
            for (let k = 0; k < matchers.length; k++) {
                if (!matchers[k].test(lines[i + k].trim())) { hit = false; break; }
            }
            if (hit) {
                matches.push({ line: i, indent: patch.match_indent ? indentOf(lines[i]) : "" });
                i += matchers.length;
            } else {
                i++;
            }
        }

        if (!matches.length) {
            warnings.push(label + ": pattern '" + patternLines[0].trim().slice(0, 90) + "' matched nothing");
            return { content: content, matches: 0, warnings: warnings };
        }

        let kept = matches;
        if (typeof patch.times === "number") {
            if (matches.length !== patch.times) {
                warnings.push(label + ": pattern matched " + matches.length + " times, wanted " + patch.times);
            }
            if (matches.length > patch.times) kept = matches.slice(0, patch.times);
        }

        const position = POSITIONS[String(patch.position || "after").toLowerCase()] || "after";
        let out = content;
        // Applied back-to-front so earlier offsets stay valid.
        for (let m = kept.length - 1; m >= 0; m--) {
            const start = offsets[kept[m].line];
            const end = offsets[kept[m].line + matchers.length];
            const payload = buildPayload(String(patch.payload === undefined ? "" : patch.payload), kept[m].indent);
            if (position === "at") out = out.slice(0, start) + payload + out.slice(end);
            else if (position === "before") out = out.slice(0, start) + payload + out.slice(start);
            else out = out.slice(0, end) + payload + out.slice(end);
        }
        return { content: out, matches: kept.length, warnings: warnings };
    }

    /**
     * Translate a Rust-regex pattern into something JS accepts. Rust's syntax is
     * mostly a subset of JS's, so this only has to deal with the spellings that
     * differ.
     */
    function toJsRegex(pattern, verbose) {
        let p = pattern.replace(/\(\?P</g, "(?<");
        if (verbose) {
            // Emulate Rust's ignore_whitespace: drop unescaped whitespace and
            // `#` comments outside character classes.
            let out = "";
            let inClass = false;
            for (let i = 0; i < p.length; i++) {
                const c = p[i];
                if (c === "\\") { out += c + (p[i + 1] || ""); i++; continue; }
                if (c === "[") inClass = true;
                if (c === "]") inClass = false;
                if (!inClass) {
                    if (/\s/.test(c)) continue;
                    if (c === "#") { while (i < p.length && p[i] !== "\n") i++; continue; }
                }
                out += c;
            }
            p = out;
        }
        return new RegExp(p, "gm");
    }

    const WORD_CHAR = /[A-Za-z0-9_]/;

    /**
     * Expand `$group` / `${group}` references the way lovely's regex engine
     * does. Names are matched greedily; a greedy name that is not a real group
     * but starts with digits falls back to the leading capture index.
     */
    function interpolateCaptures(template, match) {
        let out = "";
        for (let i = 0; i < template.length; i++) {
            if (template[i] !== "$") { out += template[i]; continue; }
            if (template[i + 1] === "$") { out += "$"; i++; continue; }
            let name = null;
            let next = i + 1;
            if (template[i + 1] === "{") {
                const close = template.indexOf("}", i + 2);
                if (close !== -1) { name = template.slice(i + 2, close); next = close + 1; }
            } else {
                const m = /^[A-Za-z0-9_]+/.exec(template.slice(i + 1));
                if (m) { name = m[0]; next = i + 1 + m[0].length; }
            }
            if (name === null) { out += "$"; continue; }
            out += lookupGroup(match, name);
            i = next - 1;
        }
        return out;
    }

    function lookupGroup(match, name) {
        if (/^[0-9]+$/.test(name)) {
            const v = match[Number(name)];
            return v === undefined ? "" : v;
        }
        if (match.groups && Object.prototype.hasOwnProperty.call(match.groups, name)) {
            const v = match.groups[name];
            return v === undefined ? "" : v;
        }
        const lead = /^[0-9]+/.exec(name);
        if (lead) {
            const v = match[Number(lead[0])];
            return (v === undefined ? "" : v) + name.slice(lead[0].length);
        }
        return "";
    }

    /** Byte span of a capture group inside the match, or null. */
    function groupSpan(match, name) {
        const key = String(name).replace(/\$/g, "");
        if (key === "0" || key === "") return { start: match.index, end: match.index + match[0].length };
        if (match.indices) {
            if (/^[0-9]+$/.test(key)) {
                const sp = match.indices[Number(key)];
                return sp ? { start: sp[0], end: sp[1] } : null;
            }
            const sp = match.indices.groups ? match.indices.groups[key] : undefined;
            return sp ? { start: sp[0], end: sp[1] } : null;
        }
        return null;
    }

    /**
     * Apply a `regex` patch.
     * @returns {{content: string, matches: number, warnings: string[]}}
     */
    function applyRegexPatch(content, patch, label) {
        const warnings = [];
        let re;
        try {
            // `d` exposes capture offsets, needed to resolve root_capture.
            re = new RegExp(toJsRegex(String(patch.pattern), !!patch.verbose).source, "gmd");
        } catch (err) {
            warnings.push(label + ": regex '" + String(patch.pattern).slice(0, 90) + "' is not valid here (" + err.message + ")");
            return { content: content, matches: 0, warnings: warnings };
        }

        const found = [];
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(content)) !== null) {
            found.push(m);
            if (m[0].length === 0) re.lastIndex++;
        }

        if (!found.length) {
            warnings.push(label + ": regex '" + String(patch.pattern).slice(0, 90) + "' matched nothing");
            return { content: content, matches: 0, warnings: warnings };
        }

        let kept = found;
        if (typeof patch.times === "number") {
            if (found.length !== patch.times) {
                warnings.push(label + ": regex matched " + found.length + " times, wanted " + patch.times);
            }
            if (found.length > patch.times) kept = found.slice(0, patch.times);
        }

        const position = POSITIONS[String(patch.position || "after").toLowerCase()] || "after";
        let out = content;

        for (let k = kept.length - 1; k >= 0; k--) {
            const match = kept[k];
            const span = groupSpan(match, patch.root_capture === undefined ? "0" : patch.root_capture);
            if (!span) {
                warnings.push(label + ": capture group '" + patch.root_capture + "' did not participate in a match");
                continue;
            }
            const linePrepend = interpolateCaptures(String(patch.line_prepend || ""), match);
            const raw = buildPayloadNoNewline(String(patch.payload === undefined ? "" : patch.payload), linePrepend);
            let payload = interpolateCaptures(raw, match);

            // Keep the payload from fusing with adjacent identifiers. Neighbours
            // are read from the unedited content, which is what lovely sees.
            if (payload.length && WORD_CHAR.test(payload[0])) {
                const pre = position === "after" ? span.end : span.start;
                if (pre > 0 && WORD_CHAR.test(content[pre - 1])) payload = " " + payload;
            }
            if (payload.length && WORD_CHAR.test(payload[payload.length - 1])) {
                const post = position === "before" ? span.start : span.end;
                if (post < content.length && WORD_CHAR.test(content[post])) payload = payload + " ";
            }

            if (position === "at") out = out.slice(0, span.start) + payload + out.slice(span.end);
            else if (position === "before") out = out.slice(0, span.start) + payload + out.slice(span.start);
            else out = out.slice(0, span.end) + payload + out.slice(span.end);
        }
        return { content: out, matches: kept.length, warnings: warnings };
    }

    /** Regex payloads get line_prepend on each line but no forced newline. */
    function buildPayloadNoNewline(payload, prefix) {
        if (!prefix) return payload;
        const parts = payload.match(/[^\n]*\n|[^\n]+/g) || [""];
        return parts.map((p) => prefix + p).join("");
    }

    function applyCopyPatch(content, patch, contents, label) {
        const warnings = [];
        const payloads = contents.slice();
        if (typeof patch.payload === "string") payloads.push(patch.payload);
        const position = String(patch.position || "append").toLowerCase();
        let out = content;
        for (const chunk of payloads) {
            if (position === "prepend") out = chunk + "\n" + out;
            else out = out + chunk + "\n";
        }
        if (!payloads.length) warnings.push(label + ": copy patch has no sources");
        return { content: out, matches: payloads.length, warnings: warnings };
    }

    function interpolateVars(content, vars) {
        const names = Object.keys(vars);
        if (!names.length) return { content: content, warnings: [] };
        const warnings = [];
        const out = content.replace(/\{\{lovely:(\w+)\}\}/g, function (whole, name) {
            if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
            warnings.push("unregistered lovely variable '" + name + "'");
            return whole;
        });
        return { content: out, warnings: warnings };
    }

    /**
     * Holds every patch collected from every mod, and applies them per target.
     */
    class LovelyPatchSet {
        constructor() {
            /** @type {Array<{kind: string, data: Object, priority: number, label: string, mod: string, seq: number}>} */
            this.entries = [];
            this.vars = {};
            this.warnings = [];
            this.seq = 0;
        }

        /**
         * @param {string} modName
         * @param {string} tomlPath Path of the .toml inside the mod, for messages
         * @param {string} text Raw .toml contents
         * @param {string} modDir Path of the mod inside the built game, for {{lovely_hack:patch_dir}}
         */
        addPatchFile(modName, tomlPath, text, modDir) {
            const label = modName + "/" + tomlPath;
            let parsed;
            try {
                const prepared = normalizeTomlStrings(
                    text.split("{{lovely_hack:patch_dir}}").join(modDir)
                );
                parsed = toml.parse(prepared);
            } catch (err) {
                this.warnings.push(label + ": could not parse (" + (err && err.message ? err.message : err) + ")");
                return 0;
            }

            const priority = (parsed.manifest && typeof parsed.manifest.priority === "number")
                ? parsed.manifest.priority : 0;
            if (parsed.vars) Object.assign(this.vars, parsed.vars);

            const patches = parsed.patches || [];
            let count = 0;
            for (let i = 0; i < patches.length; i++) {
                for (const kind of ["pattern", "regex", "copy", "module"]) {
                    if (!patches[i][kind]) continue;
                    this.entries.push({
                        kind: kind,
                        data: patches[i][kind],
                        priority: priority,
                        label: label + " #" + (i + 1),
                        mod: modName,
                        seq: this.seq++
                    });
                    count++;
                }
            }
            return count;
        }

        /** Every entry of a kind, in lovely's application order. */
        ofKind(kind) {
            return this.entries
                .filter((e) => e.kind === kind)
                .sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq));
        }

        /** Names of every file touched by a pattern/regex/copy patch. */
        targets() {
            const out = new Set();
            for (const entry of this.entries) {
                if (entry.kind === "module") continue;
                for (const target of targetList(entry.data.target)) out.add(target);
            }
            return out;
        }

        /**
         * Apply every copy/pattern/regex patch that targets `target`, then
         * interpolate variables.
         *
         * @param {string} target
         * @param {string} content
         * @param {(entry: Object) => string[]} getCopyContents Resolves a copy patch's sources
         * @returns {{content: string, applied: number, warnings: string[]}}
         */
        applyTo(target, content, getCopyContents) {
            const warnings = [];
            let applied = 0;
            let out = content;

            const applicable = (entry) => targetList(entry.data.target).indexOf(target) !== -1;

            for (const entry of this.ofKind("copy")) {
                if (!applicable(entry)) continue;
                const res = applyCopyPatch(out, entry.data, getCopyContents(entry), entry.label);
                out = res.content;
                applied += res.matches ? 1 : 0;
                warnings.push.apply(warnings, res.warnings);
            }

            const patternsThenRegexes = this.ofKind("pattern").concat(this.ofKind("regex"))
                .sort((a, b) => a.priority - b.priority);

            for (const entry of patternsThenRegexes) {
                if (!applicable(entry)) continue;
                let res;
                try {
                    res = entry.kind === "pattern"
                        ? applyPatternPatch(out, entry.data, entry.label)
                        : applyRegexPatch(out, entry.data, entry.label);
                } catch (err) {
                    warnings.push(entry.label + ": patch failed (" + (err && err.message ? err.message : err) + ")");
                    continue;
                }
                out = res.content;
                if (res.matches) applied++;
                warnings.push.apply(warnings, res.warnings);
            }

            const interp = interpolateVars(out, this.vars);
            out = interp.content;
            warnings.push.apply(warnings, interp.warnings.map((w) => target + ": " + w));

            return { content: out, applied: applied, warnings: warnings };
        }
    }

    const api = {
        LovelyPatchSet: LovelyPatchSet,
        normalizeTomlStrings: normalizeTomlStrings,
        applyPatternPatch: applyPatternPatch,
        applyRegexPatch: applyRegexPatch,
        applyCopyPatch: applyCopyPatch,
        interpolateVars: interpolateVars,
        wildmatch: wildmatch,
        targetList: targetList
    };

    if (typeof window !== "undefined") window.Lovely = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

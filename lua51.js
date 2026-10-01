/**
 * Lua 5.1 compatibility transform.
 *
 * love.js ships plain Lua 5.1, not LuaJIT, so `goto` / `::label::` (a LuaJIT
 * and Lua 5.2+ feature) is a syntax error. Steamodded and the patches it
 * injects use the "continue" idiom heavily:
 *
 *     for _, v in ipairs(t) do
 *         if skip then goto continue end
 *         ...
 *         ::continue::
 *     end
 *
 * which rewrites cleanly onto Lua 5.1's `repeat ... until true` + `do break end`:
 *
 *     for _, v in ipairs(t) do repeat
 *         if skip then do break end end
 *         ...
 *     until true end
 *
 * `repeat` is inserted at the start of the block that owns the label, and the
 * label itself becomes `until true`, so the jump lands exactly where the label
 * was. That is valid for any *forward* jump to a label in the same block or an
 * enclosing one, as long as nothing in between relies on `break` targeting an
 * outer loop (see the checks in transformLua51).
 */

(function () {
    const KEYWORDS = new Set([
        "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
        "if", "in", "local", "nil", "not", "or", "repeat", "return", "then",
        "true", "until", "while"
    ]);

    const NAME_START = /[A-Za-z_]/;
    const NAME_PART = /[A-Za-z0-9_]/;
    const DIGIT = /[0-9]/;

    /**
     * If a long bracket (`[[`, `[==[`, ...) starts at `i`, return the index just
     * past its closing bracket. Returns -1 when `i` does not start one.
     */
    function matchLongBracket(src, i) {
        if (src[i] !== "[") return -1;
        let level = 0;
        let j = i + 1;
        while (src[j] === "=") { level++; j++; }
        if (src[j] !== "[") return -1;
        const close = "]" + "=".repeat(level) + "]";
        const end = src.indexOf(close, j + 1);
        if (end === -1) return src.length;
        return end + close.length;
    }

    /**
     * @param {string} src
     * @returns {Array<{t: string, v?: string, s: number, e: number}>}
     */
    function tokenize(src) {
        const toks = [];
        const n = src.length;
        let i = 0;
        while (i < n) {
            const c = src[i];
            if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v") {
                i++;
                continue;
            }
            if (c === "-" && src[i + 1] === "-") {
                const lb = matchLongBracket(src, i + 2);
                if (lb >= 0) { i = lb; continue; }
                while (i < n && src[i] !== "\n") i++;
                continue;
            }
            if (c === "[") {
                const lb = matchLongBracket(src, i);
                if (lb >= 0) { toks.push({ t: "string", s: i, e: lb }); i = lb; continue; }
            }
            if (c === '"' || c === "'") {
                let j = i + 1;
                while (j < n) {
                    if (src[j] === "\\") { j += 2; continue; }
                    if (src[j] === c) { j++; break; }
                    j++;
                }
                toks.push({ t: "string", s: i, e: j });
                i = j;
                continue;
            }
            if (NAME_START.test(c)) {
                let j = i + 1;
                while (j < n && NAME_PART.test(src[j])) j++;
                const v = src.slice(i, j);
                toks.push({ t: KEYWORDS.has(v) ? "kw" : "name", v: v, s: i, e: j });
                i = j;
                continue;
            }
            if (DIGIT.test(c) || (c === "." && DIGIT.test(src[i + 1] || ""))) {
                let j = i;
                const hex = c === "0" && (src[i + 1] === "x" || src[i + 1] === "X");
                const expChars = hex ? "pP" : "eE";
                if (hex) j += 2;
                while (j < n) {
                    const d = src[j];
                    if ((d === "+" || d === "-") && expChars.indexOf(src[j - 1]) === -1) break;
                    if (!/[0-9a-fA-F.+\-]/.test(d) && expChars.indexOf(d) === -1) break;
                    if (!hex && /[a-dfA-DF]/.test(d)) break;
                    j++;
                }
                toks.push({ t: "number", s: i, e: j });
                i = j;
                continue;
            }
            if (c === ":" && src[i + 1] === ":") {
                toks.push({ t: "op", v: "::", s: i, e: i + 2 });
                i += 2;
                continue;
            }
            if (src.substr(i, 3) === "...") {
                toks.push({ t: "op", v: "...", s: i, e: i + 3 });
                i += 3;
                continue;
            }
            const two = src.substr(i, 2);
            if (two === "==" || two === "~=" || two === "<=" || two === ">=" || two === "..") {
                toks.push({ t: "op", v: two, s: i, e: i + 2 });
                i += 2;
                continue;
            }
            toks.push({ t: "op", v: c, s: i, e: i + 1 });
            i++;
        }
        return toks;
    }

    /**
     * A function body starts after its parameter list, not after the `function`
     * keyword, so find the token past the matching `)`.
     */
    function bodyStartOfFunction(toks, k) {
        let j = k + 1;
        while (j < toks.length && !(toks[j].t === "op" && toks[j].v === "(")) {
            if (toks[j].t === "kw") break;
            j++;
        }
        if (!toks[j] || toks[j].t !== "op" || toks[j].v !== "(") return k + 1;
        let depth = 0;
        for (; j < toks.length; j++) {
            if (toks[j].t !== "op") continue;
            if (toks[j].v === "(") depth++;
            else if (toks[j].v === ")") {
                depth--;
                if (depth === 0) return j + 1;
            }
        }
        return k + 1;
    }

    /**
     * Walk the token stream and recover the block structure, recording which
     * block every token sits in plus the labels, gotos and breaks found.
     */
    function analyze(toks) {
        const blocks = [{ kind: "chunk", parent: -1, bodyStart: 0, endTok: toks.length, labels: [] }];
        const stack = [0];
        const pendingStack = [];
        const tokenBlock = new Array(toks.length);
        const gotos = [];
        const breaks = [];
        let pendingLoop = false;

        function push(kind, bodyStart, via) {
            blocks.push({
                kind: kind,
                via: via || null,
                parent: stack[stack.length - 1],
                bodyStart: bodyStart,
                endTok: toks.length,
                labels: []
            });
            stack.push(blocks.length - 1);
            pendingStack.push(pendingLoop);
            pendingLoop = false;
        }

        function pop(k) {
            if (stack.length <= 1) throw new Error("unbalanced block near token " + k);
            blocks[stack.pop()].endTok = k;
            pendingLoop = pendingStack.pop();
        }

        for (let k = 0; k < toks.length; k++) {
            const tk = toks[k];
            tokenBlock[k] = stack[stack.length - 1];

            if (tk.t === "op") {
                // ::name::
                if (tk.v === "::" && toks[k + 1] && toks[k + 1].t === "name" &&
                    toks[k + 2] && toks[k + 2].t === "op" && toks[k + 2].v === "::") {
                    blocks[stack[stack.length - 1]].labels.push({
                        name: toks[k + 1].v,
                        startTok: k,
                        endTok: k + 2
                    });
                    tokenBlock[k + 1] = stack[stack.length - 1];
                    tokenBlock[k + 2] = stack[stack.length - 1];
                    k += 2;
                }
                continue;
            }

            // `goto` is a plain identifier in 5.1, so only treat it as a jump
            // when it is followed by a name.
            if (tk.t === "name" && tk.v === "goto" && toks[k + 1] && toks[k + 1].t === "name") {
                gotos.push({ tok: k, nameTok: k + 1, name: toks[k + 1].v, block: stack[stack.length - 1] });
                continue;
            }

            if (tk.t !== "kw") continue;

            switch (tk.v) {
                case "function": push("function", bodyStartOfFunction(toks, k)); break;
                case "for":
                case "while": pendingLoop = true; break;
                case "do": push(pendingLoop ? "loop" : "do", k + 1, "do"); break;
                case "repeat": push("loop", k + 1, "repeat"); break;
                case "then": push("if", k + 1); break;
                case "elseif": pop(k); break;
                case "else": pop(k); push("else", k + 1); break;
                case "end":
                case "until": pop(k); break;
                case "break": breaks.push({ tok: k, block: stack[stack.length - 1] }); break;
                default: break;
            }
        }

        if (stack.length !== 1) throw new Error("unbalanced block at end of file");
        return { blocks: blocks, tokenBlock: tokenBlock, gotos: gotos, breaks: breaks };
    }

    function isAncestorOrSelf(blocks, candidate, node) {
        let b = node;
        while (b !== -1) {
            if (b === candidate) return true;
            b = blocks[b].parent;
        }
        return false;
    }

    /** Nearest enclosing loop block of `block`, or -1. */
    function enclosingLoop(blocks, block) {
        let b = block;
        while (b !== -1) {
            if (blocks[b].kind === "loop") return b;
            b = blocks[b].parent;
        }
        return -1;
    }

    /**
     * Loop blocks strictly between `inner` and `outer`, innermost first. A
     * `break` in `inner` lands on the first of these rather than on `outer`, so
     * a jump past them has to be relayed with a flag.
     */
    function loopsBetween(blocks, inner, outer) {
        const found = [];
        let b = inner;
        while (b !== -1 && b !== outer) {
            if (blocks[b].kind === "loop") found.push(b);
            b = blocks[b].parent;
        }
        return found;
    }

    /**
     * Collect top-level `local` declarations inside [bodyStart, labelTok) that
     * belong directly to `block`, so they can be hoisted above the inserted
     * `repeat` when code after the label still needs them.
     */
    function findHoistableLocals(toks, src, info, block, labelTok) {
        const b = info.blocks[block];
        const decls = [];
        for (let k = b.bodyStart; k < labelTok; k++) {
            if (info.tokenBlock[k] !== block) continue;
            const tk = toks[k];
            if (tk.t !== "kw" || tk.v !== "local") continue;
            if (toks[k + 1] && toks[k + 1].t === "kw" && toks[k + 1].v === "function") {
                if (!toks[k + 2] || toks[k + 2].t !== "name") return null;
                decls.push({ names: [toks[k + 2].v], removeFrom: tk.s, removeTo: toks[k + 1].s });
                continue;
            }
            const names = [];
            let j = k + 1;
            while (toks[j] && toks[j].t === "name") {
                names.push(toks[j].v);
                j++;
                if (toks[j] && toks[j].t === "op" && toks[j].v === ",") { j++; continue; }
                break;
            }
            if (!names.length) return null;
            const assigns = toks[j] && toks[j].t === "op" && toks[j].v === "=";
            if (assigns) {
                // `local a, b = ...` becomes a plain assignment to the hoisted names.
                decls.push({ names: names, removeFrom: tk.s, removeTo: toks[k + 1].s });
            } else {
                // A bare declaration has nothing left to do once it is hoisted.
                decls.push({ names: names, removeFrom: tk.s, removeTo: toks[j] ? toks[j].s : tk.e });
            }
        }
        return decls;
    }

    /**
     * Rewrite `goto`/labels into Lua 5.1-compatible code.
     *
     * @param {string} src Lua source
     * @param {string} name Name used in warnings
     * @returns {{code: string, changed: boolean, warnings: string[]}}
     */
    function transformLua51(src, name) {
        const warnings = [];
        let changedBom = false;

        // LuaJIT skips a leading byte order mark; Lua 5.1 chokes on it. Editors
        // on Windows add them, so mod files regularly carry one.
        if (src.charCodeAt(0) === 0xfeff) {
            src = src.slice(1);
            changedBom = true;
        }

        if (!/(^|[^\w.:])goto[ \t]+[A-Za-z_]/.test(src) && !/::[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*::/.test(src)) {
            return { code: src, changed: changedBom, warnings: warnings };
        }

        const toks = tokenize(src);
        let info;
        try {
            info = analyze(toks);
        } catch (err) {
            warnings.push(name + ": could not analyse block structure (" + err.message + "), left unchanged");
            return { code: src, changed: changedBom, warnings: warnings };
        }

        // Resolve every goto to the label it jumps to.
        const groups = new Map();
        const unresolved = [];
        for (const g of info.gotos) {
            let b = g.block;
            let target = null;
            while (b !== -1) {
                for (const label of info.blocks[b].labels) {
                    if (label.name === g.name && label.startTok > g.tok) {
                        target = { block: b, label: label };
                        break;
                    }
                }
                if (target) break;
                // Labels are not visible outside the function they sit in.
                if (info.blocks[b].kind === "function") break;
                b = info.blocks[b].parent;
            }
            if (!target) {
                unresolved.push(g);
                continue;
            }
            const key = target.block + ":" + target.label.startTok;
            if (!groups.has(key)) groups.set(key, { block: target.block, label: target.label, gotos: [] });
            groups.get(key).gotos.push(g);
        }

        for (const g of unresolved) {
            warnings.push(name + ": `goto " + g.name + "` has no forward label in scope; " +
                "backward jumps cannot be expressed in Lua 5.1 and were left unchanged");
        }

        const edits = [];
        const repeatsByBlock = new Map();
        const handledLabels = new Set();

        for (const group of groups.values()) {
            const block = info.blocks[group.block];
            const labelTok = group.label.startTok;
            let bail = null;

            // Jumps from inside nested loops have to be relayed outwards with a
            // flag, since `break` only leaves one loop.
            const relayLoops = new Set();
            for (const g of group.gotos) {
                for (const loop of loopsBetween(info.blocks, g.block, group.block)) {
                    if (info.blocks[loop].via !== "do") {
                        bail = "`goto " + g.name + "` jumps out of a repeat loop, which Lua 5.1 cannot express";
                        break;
                    }
                    relayLoops.add(loop);
                }
                if (bail) break;
            }

            // A real `break` in the span would be caught by the inserted
            // `repeat`, so it has to be relayed back out past `until true`.
            const relayBreaks = [];
            if (!bail) {
                for (const br of info.breaks) {
                    if (br.tok < block.bodyStart || br.tok >= labelTok) continue;
                    if (!isAncestorOrSelf(info.blocks, group.block, br.block)) continue;
                    const loop = enclosingLoop(info.blocks, br.block);
                    if (loop !== -1 && !isAncestorOrSelf(info.blocks, loop, group.block)) continue;
                    if (loop !== group.block || block.labels.length > 1) {
                        bail = "a `break` before label `" + group.label.name +
                            "` would be captured by the inserted loop";
                        break;
                    }
                    relayBreaks.push(br);
                }
            }

            // Code after the label in the same block would fall outside the
            // inserted `repeat`, so any locals it uses have to be hoisted.
            let hoist = [];
            if (!bail && labelTok + 3 < block.endTok) {
                const decls = findHoistableLocals(toks, src, info, group.block, labelTok);
                if (decls === null) {
                    bail = "locals before label `" + group.label.name + "` could not be hoisted";
                } else {
                    const seen = new Set();
                    for (const d of decls) {
                        for (const nm of d.names) {
                            if (seen.has(nm)) {
                                bail = "local `" + nm + "` is declared twice before label `" +
                                    group.label.name + "`, cannot hoist";
                            }
                            seen.add(nm);
                        }
                    }
                    hoist = decls;
                }
            }

            if (bail) {
                warnings.push(name + ": " + bail + "; left unchanged (this file will fail to load)");
                handledLabels.add(group.label.startTok);
                continue;
            }

            handledLabels.add(group.label.startTok);

            const flag = "__lovely_goto_" + group.label.name + "_" + labelTok;
            for (const g of group.gotos) {
                const nested = loopsBetween(info.blocks, g.block, group.block).length > 0;
                edits.push({
                    s: toks[g.tok].s,
                    e: toks[g.nameTok].e,
                    text: nested ? "do " + flag + " = true; break end" : "do break end"
                });
            }
            for (const loop of relayLoops) {
                const endTok = info.blocks[loop].endTok;
                const at = toks[endTok] ? toks[endTok].e : src.length;
                edits.push({ s: at, e: at, text: " if " + flag + " then break end" });
            }
            const breakFlag = "__lovely_break_" + group.label.name + "_" + labelTok;
            for (const br of relayBreaks) {
                edits.push({
                    s: toks[br.tok].s,
                    e: toks[br.tok].e,
                    text: "do " + breakFlag + " = true; break end"
                });
            }
            edits.push({
                s: toks[labelTok].s,
                e: toks[group.label.endTok].e,
                text: relayBreaks.length
                    ? "until true if " + breakFlag + " then break end"
                    : "until true"
            });

            let prefix = relayBreaks.length ? "local " + breakFlag + " = false; " : "";
            for (const d of hoist) {
                // Hoisted names sit outside the `repeat` so code after the
                // label can still see them.
                prefix += "local " + d.names.join(", ") + "; ";
                edits.push({ s: d.removeFrom, e: d.removeTo, text: "" });
            }
            const declareFlag = relayLoops.size ? "local " + flag + " = false; " : "";
            const at = toks[block.bodyStart] ? toks[block.bodyStart].s : src.length;
            if (!repeatsByBlock.has(at)) repeatsByBlock.set(at, []);
            repeatsByBlock.get(at).push({ labelTok: labelTok, text: prefix + "repeat " + declareFlag });
        }

        // Any label nothing jumps to is still a 5.1 syntax error, so drop it -
        // unless an untransformable goto still needs it to exist.
        const neededNames = new Set(unresolved.map((g) => g.name));
        for (const block of info.blocks) {
            for (const label of block.labels) {
                if (handledLabels.has(label.startTok)) continue;
                if (neededNames.has(label.name)) continue;
                edits.push({ s: toks[label.startTok].s, e: toks[label.endTok].e, text: "" });
            }
        }

        if (!edits.length) return { code: src, changed: changedBom, warnings: warnings };

        for (const [at, entries] of repeatsByBlock) {
            // Later labels must open the outer `repeat` so each `break` lands on
            // the right `until true`.
            entries.sort((a, b) => b.labelTok - a.labelTok);
            edits.push({ s: at, e: at, text: entries.map((x) => x.text).join("") });
        }

        return { code: applyEdits(src, edits), changed: true, warnings: warnings };
    }

    function applyEdits(src, edits) {
        edits.sort((a, b) => (b.s - a.s) || (b.e - a.e));
        let out = src;
        for (const edit of edits) {
            out = out.slice(0, edit.s) + edit.text + out.slice(edit.e);
        }
        return out;
    }

    const api = {
        transform: transformLua51,
        tokenize: tokenize,
        needsTransform: function (src) {
            return src.charCodeAt(0) === 0xfeff ||
                /(^|[^\w.:])goto[ \t]+[A-Za-z_]/.test(src) ||
                /::[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*::/.test(src);
        }
    };

    if (typeof window !== "undefined") window.Lua51 = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

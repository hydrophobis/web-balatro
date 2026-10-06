# Balatro On The Web

Run the classic card game 'Balatro' on the web using the [love.js](https://github.com/2dengine/love.js) runtime.

## Installation

This project does not need to be built, so installation is as simple as using `git clone` or downloading the source from github.

## Usage

Open index.html, either through a static web server, or as a file: url, provide the Balatro.exe file, name it 'vanilla', and click 'Build'. Once it finishes, scroll down and click 'Load' by the vanilla entry in the 'Versions' table. Click 'Start Game' and Balatro will launch, fully in the browser. 

If the 'index.html' file fails when using the file: url, use a static web server such as python's http.server module.
```sh
python -m http.server
```

## Limitations

The RNG generator on the web differes from the native RNG implementation, so seeded runs will differ to the native counterparts.

Some computers run the internal WebGL shaders differently and may result in odd color effects.

## Caching

The site will cache each built version in IndexedDB, and each version will have its own save, also located in IndexedDB.

## Mods

Add mod folders with 'Add Mod Folder' before building. Point it at a single mod,
or at a folder containing several, and they are all picked up. Each mod is listed
with how it will be handled, and the build reports what it did afterwards.

Mods are patched at build time by a reimplementation of the
[Lovely](https://github.com/ethangreen-dev/lovely-injector) patch format in
[lovely.js](lovely.js): `pattern`, `regex`, `copy` and `module` patches, `target`
lists, priorities, `times`, `match_indent`, `line_prepend`, `root_capture`,
`{{lovely:var}}` and `{{lovely_hack:patch_dir}}`. Native Lovely rewrites each
file as Lua loads it; there is no way to hook that in love.js, so every patch is
applied to the source archive instead.

A patch that no longer matches the game's source is reported as a warning rather
than failing the build, which is how you find out a mod expects a different
Balatro version.

### Steamodded

[Steamodded](https://github.com/Steamodded/smods) works, and so do the mods that
depend on it. Add the Steamodded folder as a mod alongside the mods that need it,
then build as usual.

Verified by building Balatro 1.0.1n with Steamodded release 26.829.0 and with
`main` (26.927.0), and loading both in a browser: the game reaches the main menu
with its mods loaded, and 1045 of Steamodded's 1058 file-editing patches apply,
with not a single pattern failing to find its target. Of the 13 that do not
apply, 12 target buffers that only exist at runtime and one is a typo in
Steamodded that native Lovely skips too. Its 12 module injections are handled
separately, as files.

Six things make it work:

- `module` patches become real files in the archive, so `require` finds them, and
  anything marked `load_now` gets required ahead of the file it must precede.
- love.js runs plain **Lua 5.1**, not LuaJIT, so `goto`/`::label::` is a syntax
  error. [lua51.js](lua51.js) rewrites those jumps onto `repeat ... until true`
  with `break`, relaying through nested loops with a flag where `break` alone
  cannot reach. Every `.lua` file in the build goes through it, including the
  payloads mods inject and the files Steamodded loads at runtime. It also strips
  the byte order mark that editors on Windows leave behind, which LuaJIT skips
  and Lua 5.1 does not.
- `nativefs`, `lovely` and Steamodded's libcurl-based HTTPS client all reach for
  things a browser does not have. [patches.js](patches.js) replaces them: `nativefs`
  maps onto `love.filesystem` (including the absolute save-directory paths mods
  pass around, and Steamodded's redirects and path normalisation), `lovely`
  exposes a variable store with `reload_patches`/`apply_patches` that no-op
  because the patches are already baked in, and HTTPS requests report failure
  instead of erroring.
- Without the sound thread the game never builds a sound manager, and mod loaders
  register their sounds through it during startup. The build now stands one in
  early enough for that to work.
- LuaJIT's `string.format` runs any value through `tostring()` for `%s`; plain
  Lua 5.1 raises instead, and the game and its mods format nils into strings
  constantly. `web_patches.lua` coerces the arguments to match LuaJIT. Getting
  this wrong is expensive and silent: it used to swallow the error and return the
  format's first argument, which turned Steamodded's "does a localised copy of
  this atlas exist?" lookup into a hit against the atlas itself, so **every mod
  atlas was dropped** and the first modded card to be drawn crashed the game.
- WebGL is OpenGL ES, which is stricter than desktop GL: it will not compare a
  float against an integer literal, and it has no array constructors. Steamodded's
  atlas shader does both - which one depends on the release - and repairs itself
  natively through a Lovely hook this build cannot provide, so `web_patches.lua`
  repairs both cases itself. This is not cosmetic: a shader that fails to compile
  leaves a half-built object behind, and the runtime traps when it is collected,
  taking the game down with a bare `memory access out of bounds` and no Lua error
  to go on.

Known gaps:

- Only the two OpenGL ES problems above are repaired. A mod shader that needs
  more than that will still fail to compile, and that crashes the runtime rather
  than just losing an effect.
- Sounds a mod registers through Steamodded are accepted but never play, because
  the sound thread the game would hand them to is disabled on the web.
- Steamodded cannot restart the game to apply a blacklist change; reload the page
  instead.
- Mods distributed as `.zip` inside the Mods folder depend on
  `love.filesystem.mount` succeeding on an archive inside the fused game, which
  is not guaranteed. Extract them instead.

Large content mods like [Ortalab](https://github.com/EremelMods/Ortalab) and
[Cryptid](https://github.com/SpectralPack/Cryptid) are plain Steamodded mods
(no shaders, no FFI) and go through the same path as any other Steamodded
mod. Cryptid additionally depends on a mod called Amulet, which is easy to
forget to add alongside it; the build now checks every mod's declared
`dependencies` against what was actually added and reports anything still
missing, the same way it already did for a missing Steamodded.

Building a mod with hundreds of files (both of the above included) can take a
while in the Lua 5.1 conversion and patch-application passes; the build now
reports progress per file there too, and yields back to the browser
periodically during every heavy pass so the tab does not look hung while it
works through a large mod.

### Optimized mode for slower devices

The "Optimize for slower devices" checkbox does two things:

- During the build, it yields back to the browser more often while patching
  mods, trading a bit of build time for a tab that stays responsive on weak
  hardware.
- In the built game, it asks LÖVE to use cheaper nearest-neighbour texture
  filtering, forces vsync on and multisampling off (an uncapped frame rate
  and MSAA are some of the more expensive things to ask a weak GPU for every
  frame), and caps the canvas to one device pixel per CSS pixel instead of
  following the display's native pixel ratio, which is usually the single
  biggest GPU cost on a high-DPI screen paired with a slow GPU.

It is all built on real LÖVE and browser APIs rather than guesses about
Balatro's own settings, so turning it on is harmless even on a build where it
does not help.

### Lovely dump

The 'Use Lovely Dump' button is still there. Lovely writes a dump of every file
it modified when it patches native Balatro; feeding that dump in uses those files
directly instead of applying the patches here. Tick the checkbox next to each mod
that was part of the dump so its patches are not applied twice. Its modules are
still injected from the mod folder.

## Portable Builder

When a version is loaded, the 'Make Portable' button is available. The button creates and downloads a zip file which contains everything needed to run Balatro in 3 files. The zip file is 150 MiB.

To use the portable player, extract the zip archive and open index.html as a file: URL, or with a static file server. It will take a couple seconds to load.

Don't put the portable player on the internet because it contains Balatro's source and that would be illegal to distribute.

## Working Features

- Main gameplay loop
- Sound
- Saves
- Lovely mod support
- Steamodded ('SMODS'), and the mods built on it

## Planned Features

- Full OpenGL ES repair for mod shaders
- Sound for mod-registered sounds
- More accurate RNG.

## Credits

[love.js](https://github.com/2dengine/love.js) by 2dengine (Library)

[Balatro](https://www.playbalatro.com/) by LocalThunk

[Lovely](https://github.com/ethangreen-dev/lovely-injector) by Ethan Green
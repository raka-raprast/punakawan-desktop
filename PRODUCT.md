# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Tauri 2 desktop application with a webview interface on macOS, Windows, and Linux. Native file operations are handled by Rust.

## Stack

Tauri 2, TypeScript, Vite; frontend framework delegated to implementation. No cloud service is required for the listed prerequisites.

## Users

[Inference] People creating and editing visual design files on their own computer. Specific audience and collaboration requirements remain undecided.

## Product Purpose

Create, open, edit, and retain multi-page design files locally. The first priority is the functionality enumerated in `prerequisite.md`.

## Operating Context

Files live on the user's disk. Sessions may have multiple open files; imported assets and font choices must remain usable after reopening. The app needs recovery after unexpected shutdown.

## Capabilities and Constraints

`prerequisite.md` specifies: create/open/save/save as/autosave, recent projects, pages, asset import/export, local font discovery, preferences, keyboard shortcut management, multiple-file tabs, and crash recovery. [Inference] Local-first single-user editing is sufficient for this stage; collaboration and proprietary Figma file compatibility are not promised.

## Evidence on Hand

`prerequisite.md` is the only supplied product specification. No logo, brand assets, existing design files, or sample documents were supplied.

## Product Principles

- A file saved to disk is readable after reopening.
- Preserve work through autosave and recoverable drafts.
- Keep file and page navigation explicit and accessible.

---
title: "Settings and diagnostics"
description: "Units and theme, the server Open on Phone uses, plus Debug Mode and a bug reporter that bundles everything a developer needs into one file."
order: 22
---

Open Settings with `⌘,` / `Ctrl+,`, the Hew ▸ Settings… menu on macOS, the gear at the right end of the menu bar elsewhere, or the command palette. Every control applies immediately — there's no OK button — and settings sync across windows.

![The Settings window on its Units pane, with System and Format selectors](/docs/settings.webp)

## Units

Choose a **System** (Metric or Imperial) and a **Format**:

- Metric: **Meters**, **Centimeters**, or **Millimeters**
- Imperial: **Architectural** (`5' 3-1/8"`), **Fractional inches** (`60-1/8"`), or **Decimal inches** (`60.125"`)

This controls how every length is displayed and how bare typed numbers are interpreted. Geometry itself is always stored in meters, so switching formats never changes your model, and you can always type any unit explicitly regardless of the display setting ([full input reference](/learn/measurement-and-guides/)). The welcome screen offers the same choice as a single flat dropdown; both set the same persisted default.

## Theme

**Auto** follows your operating system's light/dark appearance, live. Pick **Light** or **Dark** to override.

## Advanced: your own server

The Advanced pane (desktop only) has one job: choosing where **Open on Phone** sends a model. **Hew cloud** is the default. **Self-hosted** takes the address of a server you run yourself, plus an optional **Upload key** if that server requires one. **Test connection** confirms the address answers as a Hew relay before you rely on it, and the QR code you get from File ▸ Open on Phone… then points at that server, never at app.hew3d.com. What your phone has to do differently, and how to stand up a server, is covered in [Using your own server](/learn/hew-on-your-phone/#using-your-own-server).

## Debug Mode

The Debug pane's **Enable Debug Mode** checkbox turns on deeper diagnostics for chasing a problem or helping report one:

- A rolling **diagnostic log** — on desktop it's written to the app's log directory as `diagnostic.log`; on the web there's a *Download Diagnostic Log…* button.
- **Input recording**, capturing low-level interaction events.
- Kernel **torture mode**, extra internal validation after every operation. Noticeably slower; leave it off for normal modeling.

## Reporting a bug

**Help ▸ Report Bug…** opens a dialog with a description field and a checklist of what it can include: your app version and system details, the session's recorded steps, the files the session took in, your current model, and the recent diagnostic log. Raw input events are listed too, but only when Debug Mode is on. Each row shows its size, and a **Show** link next to it previews exactly what would be sent. Untick anything you'd rather leave out. Recorded steps and the model carry your model's geometry, and imported files are the originals byte for byte: files you imported or opened, such as a `.skp`, and textures and library items you added. Untick all three to send only your description, system details, and the log.

**Send report** compresses the report and submits it privately to the Hew developer; nothing is posted publicly. The dialog shows how large the upload will be. Past 90 MB compressed it leaves out the model file, then imported files, and marks each one; **Save to file…** always keeps everything you ticked. You get back a short report ID. From there you can optionally open a public GitHub issue too, prefilled with your description, version, and that ID, but never with any attachment. See [what a report contains and how long it's kept](/privacy/bug-reports/).

If Hew stops on its error screen, click **Report this crash** there instead — it opens the same dialog, already carrying the steps that led to the crash (the model itself isn't available after a crash). A self-hosted web build, or a plain local dev build, has nowhere to send a report to; there the dialog explains that and offers **Save to file…** instead, so you can attach the file to a GitHub issue by hand.

Hew's kernel is deterministic, so a captured session usually reproduces a bug exactly. Reports with recorded steps attached tend to get fixed fast.

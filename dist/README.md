# Twin SEO for Windows

`twin-seo-win-x64.zip` → unzip it → double-click **`twin-seo.exe`**.

Nothing to install. The Node runtime is inside the executable, which is why
it is large.

## The blue warning

Windows will show **“Windows protected your PC.”** That appears for any
program without a paid code-signing certificate — it is not a virus warning.

Click **More info**, then **Run anyway**.

## What happens next

A black console window opens and your browser goes to
<http://localhost:8080>. Keep the console window open while you use the
dashboard; closing it stops the app.

Settings and Google tokens are written to a `.data` folder created next to
the executable, readable only by your Windows account. Move the `.exe` and
the `.data` folder together to keep your connection.

## Rebuilding it

This file was cross-built on Linux with:

```bash
node app/build-exe.mjs --target win-x64
```

Verified as a well-formed Windows PE32+ binary with the dashboard embedded.
The identical build for Linux was run end-to-end in an environment with no
Node installed. The Windows binary itself has not been executed on Windows —
if it misbehaves, say so and use `Twin SEO.bat` in the meantime.

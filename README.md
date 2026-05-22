# Documentum Reverse-Engineering Workspace

This repository contains a Pi extension for turning the previous assistant response into a card-based questionnaire UI.

## Extension

- `extensions/question-card-form.ts`

## Install from GitHub

After pushing this repo to GitHub, install it in another Pi instance with:

```bash
pi install git:github.com/<your-user>/<your-repo>
```

Then reload Pi:

```bash
/reload
```

## Local use

If you want to use it directly from a checkout, copy the extension into:

```bash
~/.pi/agent/extensions/
```

or place it in project-local:

```bash
.pi/extensions/
```

# MOV2MP4

Browsergebaseerde converter voor `mov2mp4.paulzuiderduin.com`.

## MVP

- Sleep of selecteer `.MOV` bestanden
- Zet bestanden om naar `.mp4` (H.264/AAC)
- Lokale conversie in de browser (geen upload)
- Download per bestand na conversie
- Fallback codec-profiel als de primaire encode faalt

## Stack

- React + Vite
- ffmpeg.wasm (`@ffmpeg/ffmpeg`, `@ffmpeg/util`)
- GitHub Pages deploy
- Geen login, geen Supabase

## Lokaal draaien

```bash
npm install
npm run dev
```

## Deploy-doel

- Domein: `mov2mp4.paulzuiderduin.com`
- Deploy: GitHub Pages

## Handmatige vervolgstappen

1. Maak een nieuwe GitHub repository `mov2mp4` (public).
2. Push deze map als eigen repository naar GitHub.
3. Zet GitHub Pages aan op de `main` branch via GitHub Actions.
4. Voeg in `mijn.host` het DNS-record voor `mov2mp4.paulzuiderduin.com` toe.
5. Stel custom domain in GitHub Pages in en forceer HTTPS.
6. Voeg later eventueel een link toe op `paulzuiderduin.com`.

## Opmerking

Conversie gebeurt lokaal in de browser via WebAssembly. Bij grote bestanden zijn CPU/RAM en browsertab-geheugen bepalend.


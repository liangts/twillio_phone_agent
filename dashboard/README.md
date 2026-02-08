# Callboard Dashboard (React)

React + TypeScript + Vite dashboard for live call monitoring and transcript control actions.

## Local development

```bash
cd dashboard
npm install
npm run dev
```

Open the printed local URL.

### API base URL

The dashboard resolves API base in this order:

1. `?api=` URL parameter
2. Saved value in browser local storage
3. `VITE_API_BASE` at build time (optional)

Examples:
- `http://localhost:5173/?api=https://phone.ocpp.evcheckpoint.net`
- `VITE_API_BASE=https://phone.ocpp.evcheckpoint.net npm run build`

## Build and checks

```bash
cd dashboard
npm run lint
npm run build
```

## Deploy to Cloudflare Pages

```bash
cd dashboard
npm run build
npx wrangler pages deploy dist --project-name <your-pages-project>
```

If your backend URL changes by environment, either:
- Deploy separate builds with different `VITE_API_BASE`, or
- Keep it unset and pass `?api=` in the dashboard URL.

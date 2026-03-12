# StockRaptor · Daily Scan Setup

## Cómo funciona

1. **GitHub Actions** lanza `scripts/scan-daily.js` cada día a las 08:00 UTC (10:00 Madrid en verano, 09:00 en invierno)
2. El script analiza los 200 tickers (~25 min) y guarda el JSON en Supabase (`scan_cache`)
3. Cuando un usuario abre el scanner, carga la caché al instante — sin esperar

---

## Configuración (5 pasos)

### 1. Supabase — crear la tabla
En Supabase → SQL Editor, ejecuta el bloque de `supabase-setup.sql` que empieza con:
```sql
create table if not exists public.scan_cache (...)
```

### 2. GitHub — subir el repositorio
Sube la carpeta `stockraptor-app` a un repositorio GitHub (puede ser privado).

### 3. GitHub Secrets — añadir credenciales
En tu repo → Settings → Secrets and variables → Actions → New secret:

| Secret | Valor |
|---|---|
| `FINNHUB_KEY` | `d6pfc69r01qo88aivvbgd6pfc69r01qo88aivvc0` |
| `SUPABASE_URL` | `https://ruqcgyctwlpjrlzmietj.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Tu clave `service_role` de Supabase → Settings → API |

> ⚠️ Usa la clave `service_role` (no la `anon`) — el worker necesita permisos de escritura.

### 4. Activar GitHub Actions
El workflow en `.github/workflows/daily-scan.yml` se activa automáticamente.
Para lanzar el primer scan manualmente:
- GitHub → Actions → "StockRaptor Daily Scan" → Run workflow

### 5. Verificar
Tras el primer run (~25 min), abre el scanner — verás los resultados cargados al instante con el banner:
> *Daily scan from Mon, Mar 13 at 08:00 · 200 companies analyzed*

---

## Cambiar la hora del scan

En `.github/workflows/daily-scan.yml`, modifica el cron:
```yaml
- cron: '0 8 * * 1-5'   # 08:00 UTC = 10:00 Madrid (verano)
- cron: '0 7 * * 1-5'   # 07:00 UTC = 09:00 Madrid (verano)
- cron: '0 13 * * 1-5'  # 13:00 UTC = 15:00 Madrid (verano)
```
[Conversor de zonas horarias →](https://www.timeanddate.com/worldclock/converter.html)

---

## Los usuarios siempre pueden forzar un re-scan

El botón **↻ RE-SCAN NOW** (o **↻ NUEVO SCAN** en español) en el banner 
lanza un scan manual completo desde el navegador del usuario (requiere ~25 min).

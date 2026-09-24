/** Open-Meteo helpers (no API key). */
export const WMO = {
  0: ['☀️', 'Ciel dégagé'], 1: ['🌤️', 'Plutôt dégagé'], 2: ['⛅', 'Partiellement nuageux'], 3: ['☁️', 'Couvert'],
  45: ['🌫️', 'Brouillard'], 48: ['🌫️', 'Brouillard givrant'],
  51: ['🌦️', 'Bruine légère'], 53: ['🌦️', 'Bruine'], 55: ['🌧️', 'Bruine dense'], 56: ['🧊', 'Bruine verglaçante'], 57: ['🧊', 'Bruine verglaçante dense'],
  61: ['🌦️', 'Pluie faible'], 63: ['🌧️', 'Pluie modérée'], 65: ['🌧️', 'Forte pluie'], 66: ['🧊', 'Pluie verglaçante'], 67: ['🧊', 'Forte pluie verglaçante'],
  71: ['🌨️', 'Neige faible'], 73: ['🌨️', 'Neige modérée'], 75: ['❄️', 'Forte neige'], 77: ['🌨️', 'Grains de neige'],
  80: ['🌦️', 'Averses faibles'], 81: ['🌧️', 'Averses'], 82: ['⛈️', 'Averses violentes'], 85: ['🌨️', 'Averses de neige'], 86: ['❄️', 'Fortes averses de neige'],
  95: ['⛈️', 'Orage'], 96: ['⛈️', 'Orage avec grêle'], 99: ['⛈️', 'Orage violent avec grêle'],
};
export const weatherInfo = (code) => WMO[code] || ['🌡️', `Code météo ${code}`];

export const DAILY_VARS = ['weathercode', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'precipitation_probability_max', 'windspeed_10m_max', 'windgusts_10m_max'];

export function geocodeUrl(name, count = 1) {
  return `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=${count}&language=fr&format=json`;
}
export function forecastUrl(lat, lon, days = 7) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&daily=${DAILY_VARS.join(',')}&timezone=auto&forecast_days=${Math.max(1, Math.min(16, days))}&windspeed_unit=kmh`;
}

export function placeLabel(p) {
  return [p.name, p.admin1 && p.admin1 !== p.name ? p.admin1 : null, p.country].filter(Boolean).join(', ');
}

/**
 * Compute dangerous-weather alerts for day index i of an Open-Meteo `daily` block.
 * thresholds = { wind: km/h, gust: km/h, rain: mm, heat: °C, cold: °C }
 */
export function computeAlerts(daily, i, thresholds = {}) {
  const t = { wind: 70, gust: 90, rain: 30, heat: 38, cold: -10, ...thresholds };
  const code = daily.weathercode?.[i];
  const wind = daily.windspeed_10m_max?.[i];
  const gust = daily.windgusts_10m_max?.[i];
  const rain = daily.precipitation_sum?.[i];
  const tmax = daily.temperature_2m_max?.[i];
  const tmin = daily.temperature_2m_min?.[i];
  const alerts = [];
  if (code >= 95 && code <= 99) alerts.push({ type: 'storm', emoji: '⛈️', label: code === 95 ? 'Orages' : 'Orages avec grêle' });
  if ((typeof wind === 'number' && wind > t.wind) || (typeof gust === 'number' && gust > t.gust)) alerts.push({ type: 'wind', emoji: '💨', label: `Vent violent (${Math.round(wind ?? 0)} km/h${typeof gust === 'number' ? `, rafales ${Math.round(gust)} km/h` : ''})` });
  if ((typeof rain === 'number' && rain >= t.rain) || [65, 67, 82].includes(code)) alerts.push({ type: 'rain', emoji: '🌧️', label: `Fortes pluies (${typeof rain === 'number' ? rain.toFixed(1) : '?'} mm)` });
  if ([75, 86].includes(code)) alerts.push({ type: 'snow', emoji: '❄️', label: 'Fortes chutes de neige' });
  if ([56, 57, 66, 67].includes(code)) alerts.push({ type: 'ice', emoji: '🧊', label: 'Risque de verglas' });
  if (typeof tmax === 'number' && tmax >= t.heat) alerts.push({ type: 'heat', emoji: '🥵', label: `Canicule (${Math.round(tmax)} °C)` });
  if (typeof tmin === 'number' && tmin <= t.cold) alerts.push({ type: 'cold', emoji: '🥶', label: `Grand froid (${Math.round(tmin)} °C)` });
  return alerts;
}

export function windDirection(deg) {
  if (typeof deg !== 'number') return '';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  return dirs[Math.round(deg / 45) % 8];
}

export function dayLabel(isoDate, index) {
  if (index === 0) return "Aujourd'hui";
  if (index === 1) return 'Demain';
  const d = new Date(`${isoDate}T12:00:00Z`);
  const s = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

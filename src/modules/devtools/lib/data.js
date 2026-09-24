/** Static reference data: HTTP status codes, MIME types, HTML entities. */
export const HTTP_STATUS = {
  100: ['Continue', 'Le serveur a reçu les en-têtes ; le client peut envoyer le corps de la requête.'],
  101: ['Switching Protocols', 'Le serveur accepte de changer de protocole (ex : passage à WebSocket).'],
  102: ['Processing', 'WebDAV : la requête est en cours de traitement, pas encore de réponse.'],
  103: ['Early Hints', 'Indices préliminaires (en-têtes Link) avant la réponse finale, pour précharger des ressources.'],
  200: ['OK', 'Requête réussie.'],
  201: ['Created', 'Ressource créée avec succès (souvent après un POST).'],
  202: ['Accepted', 'Requête acceptée, traitement asynchrone en cours.'],
  203: ['Non-Authoritative Information', 'Réponse modifiée par un proxy.'],
  204: ['No Content', 'Succès, aucun contenu à renvoyer.'],
  205: ['Reset Content', 'Succès ; le client doit réinitialiser la vue (formulaire…).'],
  206: ['Partial Content', 'Contenu partiel (requête Range).'],
  207: ['Multi-Status', 'WebDAV : plusieurs statuts pour plusieurs ressources.'],
  208: ['Already Reported', 'WebDAV : membres déjà listés.'],
  226: ['IM Used', 'Réponse résultant de manipulations d\'instance (delta encoding).'],
  300: ['Multiple Choices', 'Plusieurs réponses possibles.'],
  301: ['Moved Permanently', 'Ressource déplacée définitivement (en-tête Location). Les moteurs mettent à jour leurs liens.'],
  302: ['Found', 'Redirection temporaire (en-tête Location).'],
  303: ['See Other', 'Voir une autre ressource via GET (après un POST par exemple).'],
  304: ['Not Modified', 'Ressource inchangée depuis la version en cache (ETag / If-Modified-Since).'],
  305: ['Use Proxy', 'Obsolète : la ressource doit être accédée via un proxy.'],
  307: ['Temporary Redirect', 'Redirection temporaire en conservant la méthode HTTP.'],
  308: ['Permanent Redirect', 'Redirection permanente en conservant la méthode HTTP.'],
  400: ['Bad Request', 'Requête mal formée ou invalide.'],
  401: ['Unauthorized', 'Authentification requise ou invalide.'],
  402: ['Payment Required', 'Paiement requis (réservé, peu utilisé).'],
  403: ['Forbidden', 'Accès refusé malgré l\'authentification.'],
  404: ['Not Found', 'Ressource introuvable.'],
  405: ['Method Not Allowed', 'Méthode HTTP non autorisée pour cette ressource.'],
  406: ['Not Acceptable', 'Aucune représentation ne correspond aux en-têtes Accept.'],
  407: ['Proxy Authentication Required', 'Authentification auprès du proxy requise.'],
  408: ['Request Timeout', 'Le serveur a attendu la requête trop longtemps.'],
  409: ['Conflict', 'Conflit avec l\'état actuel de la ressource.'],
  410: ['Gone', 'Ressource supprimée définitivement.'],
  411: ['Length Required', 'En-tête Content-Length requis.'],
  412: ['Precondition Failed', 'Une précondition (If-Match…) a échoué.'],
  413: ['Content Too Large', 'Corps de requête trop volumineux.'],
  414: ['URI Too Long', 'URI trop longue.'],
  415: ['Unsupported Media Type', 'Type de contenu non supporté.'],
  416: ['Range Not Satisfiable', 'Plage demandée invalide.'],
  417: ['Expectation Failed', 'L\'en-tête Expect ne peut être satisfait.'],
  418: ['I\'m a teapot', 'Je suis une théière (RFC 2324, poisson d\'avril).'],
  421: ['Misdirected Request', 'Requête envoyée à un serveur incapable d\'y répondre.'],
  422: ['Unprocessable Content', 'Requête bien formée mais sémantiquement invalide (validation).'],
  423: ['Locked', 'WebDAV : ressource verrouillée.'],
  424: ['Failed Dependency', 'WebDAV : une requête dont celle-ci dépend a échoué.'],
  425: ['Too Early', 'Le serveur refuse de traiter une requête potentiellement rejouée.'],
  426: ['Upgrade Required', 'Le client doit changer de protocole (ex : TLS).'],
  428: ['Precondition Required', 'La requête doit être conditionnelle.'],
  429: ['Too Many Requests', 'Trop de requêtes (limite de débit). Voir Retry-After.'],
  431: ['Request Header Fields Too Large', 'En-têtes trop volumineux.'],
  451: ['Unavailable For Legal Reasons', 'Indisponible pour raisons légales.'],
  500: ['Internal Server Error', 'Erreur interne du serveur.'],
  501: ['Not Implemented', 'Fonctionnalité non supportée par le serveur.'],
  502: ['Bad Gateway', 'Réponse invalide reçue d\'un serveur en amont (proxy / passerelle).'],
  503: ['Service Unavailable', 'Service temporairement indisponible (maintenance, surcharge).'],
  504: ['Gateway Timeout', 'Le serveur en amont n\'a pas répondu à temps.'],
  505: ['HTTP Version Not Supported', 'Version HTTP non supportée.'],
  506: ['Variant Also Negotiates', 'Erreur de configuration de la négociation de contenu.'],
  507: ['Insufficient Storage', 'WebDAV : espace de stockage insuffisant.'],
  508: ['Loop Detected', 'WebDAV : boucle infinie détectée.'],
  510: ['Not Extended', 'Extensions supplémentaires requises.'],
  511: ['Network Authentication Required', 'Authentification réseau requise (portail captif).'],
  520: ['Unknown Error (Cloudflare)', 'Cloudflare : réponse inattendue du serveur d\'origine.'],
  521: ['Web Server Is Down (Cloudflare)', 'Cloudflare : le serveur d\'origine refuse la connexion.'],
  522: ['Connection Timed Out (Cloudflare)', 'Cloudflare : délai de connexion à l\'origine dépassé.'],
  523: ['Origin Is Unreachable (Cloudflare)', 'Cloudflare : origine injoignable.'],
  524: ['A Timeout Occurred (Cloudflare)', 'Cloudflare : l\'origine a mis trop de temps à répondre.'],
  525: ['SSL Handshake Failed (Cloudflare)', 'Cloudflare : échec de la négociation TLS avec l\'origine.'],
  526: ['Invalid SSL Certificate (Cloudflare)', 'Cloudflare : certificat de l\'origine invalide.'],
};
export const HTTP_CLASSES = { 1: 'ℹ️ Information', 2: '✅ Succès', 3: '↪️ Redirection', 4: '⚠️ Erreur client', 5: '💥 Erreur serveur' };

export const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', json: 'application/json', jsonld: 'application/ld+json', xml: 'application/xml', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', ics: 'text/calendar', vcf: 'text/vcard', yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/vnd.microsoft.icon', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif', jxl: 'image/jxl', psd: 'image/vnd.adobe.photoshop',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4', weba: 'audio/webm', mid: 'audio/midi', midi: 'audio/midi',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska', mpeg: 'video/mpeg', ts: 'video/mp2t', '3gp': 'video/3gpp',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', bz2: 'application/x-bzip2', xz: 'application/x-xz', zst: 'application/zstd',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation', rtf: 'application/rtf', epub: 'application/epub+zip',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm', exe: 'application/vnd.microsoft.portable-executable', msi: 'application/x-msdownload', dmg: 'application/x-apple-diskimage', deb: 'application/vnd.debian.binary-package', rpm: 'application/x-rpm', apk: 'application/vnd.android.package-archive', jar: 'application/java-archive', iso: 'application/x-iso9660-image', bin: 'application/octet-stream',
  sh: 'application/x-sh', py: 'text/x-python', php: 'application/x-httpd-php', java: 'text/x-java-source', c: 'text/x-c', cpp: 'text/x-c++', rs: 'text/x-rust', go: 'text/x-go', sql: 'application/sql', webmanifest: 'application/manifest+json', map: 'application/json', torrent: 'application/x-bittorrent', eml: 'message/rfc822', swf: 'application/x-shockwave-flash',
};

export const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', deg: '°', plusmn: '±', times: '×', divide: '÷', micro: 'µ', middot: '·', bull: '•', hellip: '…', prime: '′', Prime: '″',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', ndash: '–', mdash: '—', iexcl: '¡', iquest: '¿', shy: '­', ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '‍', zwnj: '‌',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', lArr: '⇐', rArr: '⇒', hArr: '⇔', infin: '∞', ne: '≠', le: '≤', ge: '≥', asymp: '≈', equiv: '≡', sum: '∑', prod: '∏', radic: '√', part: '∂', nabla: '∇', isin: '∈', notin: '∉', cap: '∩', cup: '∪', sub: '⊂', sup: '⊃', and: '∧', or: '∨', forall: '∀', exist: '∃', empty: '∅', frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', permil: '‰', loz: '◊', spades: '♠', clubs: '♣', hearts: '♥', diams: '♦', dagger: '†', Dagger: '‡', ordf: 'ª', ordm: 'º', not: '¬', macr: '¯', acute: '´', cedil: '¸', uml: '¨', curren: '¤', brvbar: '¦',
  Alpha: 'Α', alpha: 'α', Beta: 'Β', beta: 'β', Gamma: 'Γ', gamma: 'γ', Delta: 'Δ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', Pi: 'Π', sigma: 'σ', Sigma: 'Σ', tau: 'τ', phi: 'φ', omega: 'ω', Omega: 'Ω',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', OElig: 'Œ', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', Yuml: 'Ÿ', szlig: 'ß',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', oelig: 'œ', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ',
};
const REVERSE_ENTITIES = Object.fromEntries(Object.entries(ENTITIES).filter(([k]) => !['nbsp', 'shy', 'ensp', 'emsp', 'thinsp', 'zwj', 'zwnj'].includes(k) || true).map(([k, v]) => [v, k]));

export function encodeEntities(s, { mode = 'minimal' } = {}) {
  return Array.from(String(s)).map((ch) => {
    if (ch === '&') return '&amp;'; if (ch === '<') return '&lt;'; if (ch === '>') return '&gt;'; if (ch === '"') return '&quot;'; if (ch === "'") return '&#39;';
    if (mode === 'minimal') return ch;
    const cp = ch.codePointAt(0);
    if (cp < 128) return ch;
    if (mode === 'named' && REVERSE_ENTITIES[ch]) return `&${REVERSE_ENTITIES[ch]};`;
    return `&#${cp};`;
  }).join('');
}
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (m, e) => {
    if (e[0] === '#') { const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; }
    return ENTITIES[e] ?? m;
  });
}

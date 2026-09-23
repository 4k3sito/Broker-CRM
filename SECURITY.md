# Seguridad de OfficeLab

Registro vivo de cómo se protegen las cuentas y los datos, qué se ha verificado
contra el sitio en producción y qué sigue abierto.

**Se actualiza en el mismo commit que el cambio.** Si tocas auth, sesiones, la API,
Caddy o el despliegue y este archivo no cambia, el cambio está incompleto.

- Última revisión completa: **2026-08-28** (cron de scrapers y su control de calidad: 2026-09-10;
  retirada de Supabase: 2026-09-19)
- Sitio en producción: `http://31.220.56.100` (VPS propio, sin dominio todavía)
- Alcance: cuentas de asesores, CRM (clientes, fichas, procesos) e inventario scrapeado

---

## 1. Qué hay que proteger

| Activo | Dónde vive | Si se filtra |
|---|---|---|
| Contraseñas de asesores | `usuario.password_hash` (PostGIS) | acceso a todo el CRM |
| Sesiones activas | `sesion.token_hash` | suplantación hasta que expire |
| Tokens de recuperación | `reset_token.token_hash` | toma de cuenta en ≤30 min |
| Datos de clientes | `cliente`, `ficha`, `proceso` | datos de terceros — es lo más sensible del sistema |
| Credenciales de proxy de scraping | `scrapers/.env` (gitignored) | gasto ajeno a cuenta del proyecto |
| Secretos del stack | `vps/.env` en el VPS | control total de la base |

El inventario de listings es público por naturaleza (viene de portales abiertos):
no es secreto, pero sí es el trabajo acumulado de muchas horas de scraping.

## 2. Cómo se guardan las contraseñas

Implementado en `api/main.py`, sin dependencias externas — todo sale de la stdlib.

- **scrypt con N=2^17, r=8, p=1, dklen=32** y sal única de 16 bytes por contraseña.
  Es el mínimo que pide el [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
  cuando no se usa Argon2id. Formato guardado: `scrypt$n$r$p$salt_hex$dk_hex`.
- **Los parámetros se leen del hash guardado, no de las constantes.** Por eso subir
  el costo no invalida ninguna contraseña: `necesita_rehash()` lo detecta y el login
  re-escribe el hash con los parámetros nuevos. Es el único momento en que la
  contraseña existe en claro en memoria.
- **Comparación en tiempo constante** (`hmac.compare_digest`).
- **`DUMMY_HASH`**: cuando el correo no existe se verifica igual contra un hash
  desechable, para que la latencia de la respuesta no delate qué correos están
  registrados.
- **Mínimo 15 caracteres**, sin reglas de composición. [NIST SP 800-63B Rev.4](https://www.enzoic.com/blog/nist-sp-800-63b-rev4/)
  (julio 2025) pide 15 cuando la contraseña es el único factor y **prohíbe** exigir
  mayúsculas/números/símbolos: sólo producen `Passw0rd!`.
- **Rechazo de contraseñas filtradas** vía Have I Been Pwned por k-anonymity: viajan
  los 5 primeros caracteres hex del SHA-1 y vuelven ~800 sufijos. La contraseña
  nunca sale del servidor. **Falla abierto** a propósito: que un tercero esté caído
  no debe impedirle a nadie recuperar su cuenta.

Nadie —ni el administrador con root— puede leer una contraseña. La única vía
para entrar a una cuenta ajena es resetearla, y eso deja rastro.

## 3. Sesiones

- **Opacas y en la base, no JWT.** Se revocan borrando la fila; no hay llave que rotar.
- Se guarda el **sha256 del token**, nunca el token: leer la base no otorga sesiones.
- Cookie `httponly` + `samesite=strict`, 30 días. `secure` depende de `COOKIE_SECURE`,
  hoy en 0 — ver el hallazgo H2.
- Cambiar la contraseña cierra las **demás** sesiones y conserva la actual.
  Resetearla las cierra **todas**, incluida la de quien la esté cambiando.

## 4. Recuperación de contraseña

Sigue el [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html):

| Requisito | Cómo se cumple |
|---|---|
| Token de alta entropía | `secrets.token_urlsafe(32)` = 256 bits (OWASP pide ≥128) |
| Guardado hasheado | sólo el sha256 entra a `reset_token` |
| Un solo uso | `used_at`; confirmar quema **todos** los tokens vivos del usuario |
| Vida corta | 30 minutos |
| Sin enumeración de usuarios | `/api/reset/solicitar` responde `{"ok":true}` exista o no la cuenta |
| Sin pistas al atacante | token gastado, vencido e inventado dan el **mismo** 400 |
| Invalidar sesiones | el reset borra todas las sesiones del usuario |
| Límite de intentos | `rate_limit` en solicitar y confirmar |

**Entrega manual, por ahora.** No hay dominio, y un correo transaccional sin SPF/DKIM
alineados acaba en spam. `main.py resetlink <correo>` imprime el link y el admin lo
entrega por fuera. `reset_solicitar` ya emite el token, así que cablear el envío es
una sola función — el resto del flujo no cambia.

## 5. Autorización del CRM

No hay RLS (eso murió con Supabase). En su lugar, **cada endpoint filtra por el
`user_id` de la sesión**, tomado de la cookie: el cliente nunca manda un `user_id`.
`_patch()` usa lista blanca de columnas, así que mandar campos de más no permite
escribir `user_id` ni `id`.

Verificado con dos cuentas: A no ve, no edita (404) ni borra (404) los datos de B, y
B no puede colgar un proceso de una ficha ajena (404).

**Excepción deliberada: las tareas.** `tarea` NO se filtra por `user_id` — es un tablero
de equipo, y el diseño muestra la carga de todas las personas. Cualquiera con sesión ve,
mueve, reasigna y borra cualquier tarea; `user_id` sólo registra quién la creó. Está
escrito así en `api/main.py` para que no se lea como un filtro olvidado. Si algún día
hacen falta equipos separados, esto es lo primero que hay que cambiar.

## 6. Superficie expuesta — medido el 2026-08-28

```
LISTEN 0.0.0.0:443   docker-proxy      LISTEN 0.0.0.0:80   docker-proxy
LISTEN 0.0.0.0:22    sshd
```

- **La base y la API nunca salen a internet**: `127.0.0.1:5432` y `127.0.0.1:8000`.
  El único camino hacia la API es Caddy. El acceso remoto a la base es por túnel SSH.
- **Caddy sirve `web/`, no la raíz del repo.** Decisión deliberada: con root en el
  repo, `/vps/.env` sería descargable desde internet.
- `docs_url=None, redoc_url=None`: la API no publica su propio esquema.
- **Segunda API en `127.0.0.1:8001`** desde el 2026-09-23 (`vps/docker-compose.dev.yml`),
  la de la copia de trabajo `/srv/officelab-dev`. Sólo loopback, Caddy no la conoce, y
  usa la misma base que producción: lo que escriba ahí es real. Se apaga con
  `docker compose -p officelab-dev -f docker-compose.dev.yml down`.
- **`GET /api/lugares`** (autocompletado del filtro de ubicación) pide sesión como el
  resto. Devuelve nombres de municipio y de colonia con su conteo de inventario — datos
  públicos del catálogo, no del seguimiento privado de ningún asesor. El parámetro `q`
  va parametrizado contra un `LIKE` sobre la columna `norm`, sin concatenar nada.
- Cabeceras que sí manda (verificadas con `curl -D -`):

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;
  img-src 'self' https: data:; connect-src 'self'; form-action 'self';
  frame-ancestors 'none'; base-uri 'none'; object-src 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()
Cache-Control: no-store          (sólo /api/*)
Cache-Control: no-cache          (sólo los estáticos de web/)
```

Las dos directivas de caché dicen cosas distintas a propósito. `no-store` en `/api/*` es
"no guardes nada": las respuestas son por usuario y no deben quedar en disco de nadie.
`no-cache` en los estáticos es "pregunta antes de usar", que con el `ETag` de
`file_server` se contesta con un 304 sin cuerpo.

El segundo se añadió el **2026-09-21**, y no es cosmético. Sin ninguna directiva de
caché, el navegador aplica **frescura heurística** —se inventa un plazo de ~10% de la
edad del archivo y no revalida—, así que un archivo que llevaba días sin tocarse se
quedaba servido horas después de desplegar. Ese día se publicó un `api.js` nuevo y la
ficha reventó con `API.pdfAnalisis is not a function` teniendo el archivo correcto en el
servidor. Importa para seguridad y no sólo para comodidad: **un parche de frontend no
llegaba a los navegadores que ya habían visitado el sitio**, que son todos los de los
asesores.

`script-src 'self'` sin `unsafe-inline` es posible porque el tablero **no tiene ni un
`<script>` inline ni un `onclick=`**. Por eso el tema oscuro vive en `web/theme.js`
—un archivo propio cargado sin `defer` en el `<head>`— y no en el `<script>` de dos
líneas que sería lo normal para evitar el parpadeo: la CSP no lo permitiría. `Referrer-Policy: no-referrer` importa ahora que
el token de recuperación viaja en la query string: sin él, se filtraría en el `Referer`
al pedir las fuentes a Google.

---

### Endpoints (2026-09-01)

`GET /api/scrapers` se suma a la lista. Como todo lo demás salvo `/api/health` y el
flujo de recuperación, exige sesión (`Depends(current_user)`), no toma un solo
parámetro del cliente y sólo devuelve **agregados** de `listings` —conteos, coberturas
y fechas de carga por fuente—: ni una URL, ni un precio, ni una fila individual. No
expone nada que el tablero no muestre ya, y no toca `user_listing`, así que el
seguimiento de un asesor no se filtra a otro.

### Endpoints (2026-09-21) — análisis de mercado

`GET /api/analisis/{listing_id}` y `GET /api/analisis-pdf/{listing_id}` se suman a la
lista. Los dos exigen sesión (`Depends(current_user)`) y no tocan `user_listing`, así
que el seguimiento de un asesor no se filtra a otro. Tres cosas que sí cambian respecto
a lo que había:

- **Devuelven filas individuales, no agregados.** A diferencia de `/api/scrapers`, el
  análisis publica título, superficie, precio unitario y distancia de hasta doce
  anuncios. Todo eso ya es visible en el tablero para cualquier usuario con sesión, así
  que no amplía lo que un asesor puede ver — pero sí lo empaqueta en un archivo que sale
  del sistema y que nadie controla una vez enviado. Es una decisión de producto tomada a
  sabiendas, no un descuido: el documento existe para mandarse.
- **El nombre del archivo se filtra.** `listing_id` viene de la URL y acaba en la
  cabecera `Content-Disposition`. Se recorta a `[A-Za-z0-9._-]` y a 60 caracteres
  (`api/main.py`, `get_analisis_pdf`); sin eso, una comilla o un salto de línea dejan de
  ser un nombre de archivo y pasan a ser una cabecera inyectada.
- **Todo lo que escribieron los portales se escapa.** El título y la ubicación de cada
  anuncio entran al HTML que renderiza WeasyPrint; `api/documento.py` los pasa por
  `html.escape` y su selfcheck lo comprueba con un título que contiene `<script>`.

La imagen del contenedor `api` suma WeasyPrint y las librerías de Pango. Es superficie
nueva —un motor de render de HTML/CSS procesando texto de terceros—, acotada por tres
cosas: el proceso sigue corriendo como `nobody`, el HTML lo genera la propia API y nunca
viene del cliente, y WeasyPrint no ejecuta JavaScript.

---

## 7. Hallazgos abiertos

### H1 — SSH root con contraseña, sin firewall ni fail2ban · **crítico**

```
permitrootlogin yes        passwordauthentication yes
ufw: inactive              fail2ban: inactive
```

El puerto 22 está abierto a internet aceptando **contraseña para root**, sin nada que
frene la fuerza bruta. Es el agujero más grande del sistema: hoy toda la seguridad de
la aplicación cuelga de que nadie adivine esa contraseña. Un VPS público recibe miles
de intentos al día.

Sin `ufw` **cualquier puerto que alguien abra queda expuesto sin decidirlo**. El caso
concreto es `npm run dev`: `dev-server.js` hace `listen(3000)` sin host, así que escucha
en todas las interfaces, y mientras corre el previsualizador de `/srv/officelab-dev` es
alcanzable desde internet. Sirve los mismos estáticos que el sitio y su `/api` sigue
pidiendo sesión, así que no regala datos, pero es superficie que nadie eligió publicar.
Mientras H1 siga abierto, el previsualizador se apaga al terminar de usarlo.

**Arreglo:** con la llave ya instalada y probada, `PasswordAuthentication no` y
`PermitRootLogin prohibit-password` en `/etc/ssh/sshd_config.d/`, más `ufw` limitado a
22/80/443 y `fail2ban`. *Requiere confirmación: hacerlo mal deja el VPS inaccesible.*

### H2 — Todo el tráfico va en claro · **alto**

Sin dominio no hay TLS, así que:
- la cookie de sesión viaja sin cifrar y **no puede llevar `Secure`** (`COOKIE_SECURE=0`);
- el token de recuperación viaja en la URL de una petición HTTP;
- las contraseñas viajan en claro en cada login.

Cualquiera en la ruta de red las ve. Aceptado conscientemente mientras se decide el
dominio, **no** es un descuido.

**Arreglo:** dominio → Caddy saca el certificado solo → `COOKIE_SECURE=1`, `BASE_URL`
al dominio y añadir `Strict-Transport-Security "max-age=31536000; includeSubDomains"`.
Hoy ese header sería una trampa: sin TLS el navegador no podría volver a entrar.

### H3 — El límite de intentos no sobrevive a un reinicio · **medio**

`rate_limit` cuenta en un diccionario en memoria de un solo proceso. Reiniciar la API
borra el contador, y con más de un worker cada uno llevaría el suyo. Ya está anotado
con `ponytail:` en el código.

**Arreglo cuando haga falta:** mover el contador a una tabla. Hoy no hay evidencia de
que se necesite (un worker, tres usuarios).

### H4 — `style-src 'unsafe-inline'` · **bajo**

`app.js` pinta el color de estado con atributos `style=` en cada tarjeta, así que la
CSP tiene que permitir estilos inline. Reduce la protección contra XSS inyectado en
datos de scraping (títulos, direcciones).

**Arreglo:** cambiar esos `style=` por clases CSS por estado y quitar `unsafe-inline`.

### H6 — El agente de IA del VPS trae shell de root por defecto · **medio**

`hermes` (Nous Research, `/usr/local/bin/hermes`) está instalado como root con los
toolsets `terminal`, `file`, `code_execution`, `browser` y `computer_use` **habilitados**,
y su modo de una sola pregunta (`-z`) los usa sin pedir aprobación. Medido el 2026-09-10:
`hermes --cli -z "corre el comando id"` devolvió `uid=0(root)`. `-t ""` **no** los apaga.

Por qué importa aquí: lo que `qa.py` le da a leer incluye texto que escribieron los
portales (los `location` de los anuncios). Sin restringir, la cadena es
anuncio ajeno → JSONL → auditoría → prompt → shell de root.

**Mitigado en el uso del pipeline, no en la instalación.** `qa.py` llama a hermes con
`-t memory` (lista blanca — verificado: el mismo prompt contesta "SIN-HERRAMIENTAS")
y sanea el texto con `limpiar()` antes de armar el prompt. Cualquier *otro* uso de
hermes en el VPS —interactivo, o un script nuevo— vuelve a estar expuesto.

**Arreglo de raíz:** `hermes tools disable terminal file code_execution` en el VPS, o
un perfil aparte (`hermes profile create`) sin esas herramientas. No se hizo porque la
instalación es del usuario y apagarlas le cambia su propio uso interactivo del agente.

### H9 — El PDF es el primer endpoint con costo abierto · **bajo**

`GET /api/analisis-pdf/{listing_id}` es, medido el 2026-09-21, ~450 ms de consulta más
el render de WeasyPrint: es el único endpoint del producto cuyo costo no está acotado
por una página de resultados. Un usuario con sesión que lo pida en bucle ocupa CPU del
VPS y, con `max_size=4` en el pool, puede dejar al resto de la API esperando conexión.

**Lo que no es:** no es anónimo —exige sesión— y hoy hay cinco cuentas, todas de gente
conocida. La exposición real es que una pestaña abierta con recarga automática, o un
script de un asesor, tire el tablero sin mala intención.

**Arreglo:** el límite de intentos que ya existe (`rate_limit`, `api/main.py:167`) sólo
cubre el login. Extenderlo a este endpoint por usuario —unos pocos documentos por
minuto— es el camino corto. Lo de fondo es que el límite viva en Caddy y no en memoria
del proceso, que es lo mismo que pide H3.

### H5 — Sin registro de auditoría · **bajo**

No queda rastro de logins exitosos ni de cambios de contraseña. `reset_token` guarda
`solicitado_desde` y `created_at`, que es un principio, pero no hay historial de accesos.

### H8 — Cuenta de servicio para verificación de frontend · **bajo**

El 2026-09-20 se creó `verificacion-dom@officelab.local` para poder entrar con un
navegador automatizado y leer el DOM de las páginas con sesión, que es la única forma de
verificar un cambio de frontend (ver `CLAUDE.md`). **Es una cuenta con los mismos
permisos que la de cualquier asesor**: el modelo de autorización no distingue roles, así
que ve el CRM completo —clientes, fichas y procesos— igual que una persona.

Su contraseña se generó con `adduser --generar` y se mostró una sola vez; no está en el
repo ni en ningún archivo del VPS. No caduca, y no hay registro de accesos que permita
distinguir su uso del de una persona (ver H5).

**Rotada el 2026-09-21** con `passwd --generar`, para verificar en el navegador el botón
del análisis de mercado; la rotación cerró las 40 sesiones que esa misma cuenta tenía
abiertas, restos de corridas de verificación anteriores que nadie había cerrado. La cuenta **sigue existiendo** y sigue pendiente de borrarse.

**Arreglo:** borrarla cuando deje de hacer falta —
`docker compose exec -T api python main.py deluser verificacion-dom@officelab.local`,
que arrastra su CRM en cascada— o, si se queda, rotarle la contraseña con la misma
frecuencia que a una cuenta de persona. Lo correcto de fondo es que la API distinga un
rol de sólo lectura, que hoy no existe.

### H7 — El proyecto de Supabase puede seguir vivo · **bajo**

El repo ya no habla con Supabase por ningún lado (ver §8, 2026-09-19), pero eso sólo
cierra *nuestro* extremo. Si el proyecto sigue existiendo en el panel, sigue existiendo
una copia del CRM del 2026-08-27 —clientes, fichas y procesos, que es lo más sensible
del sistema— alcanzable con la **service key** que se usó para migrar, y que salta RLS
por diseño. Esa key vivió en el entorno de la migración; no está en el repo, pero
tampoco consta que se haya revocado.

**Arreglo:** en el panel de Supabase, rotar o revocar la service key y borrar el
proyecto. Es manual y fuera del VPS — nadie puede verificarlo desde aquí.

---

## 8. Resuelto

| Fecha | Qué | Detalle |
|---|---|---|
| 2026-09-20 | Escapado desigual en la ficha, y `href` sin validar esquema | `listing.js` metía a `innerHTML` el título, la dirección, la descripción y las características de un anuncio **sin escapar**, mientras `app.js` sí escapaba esos mismos campos: contenido de portales scrapeados, o sea de terceros. La CSP (`script-src 'self'`, sin `unsafe-inline`) impedía la ejecución, así que era inyección de marcado y no XSS, pero dependía por completo de esa línea del Caddyfile. Había cinco copias del escapador y ninguna con casa; ahora hay una, en `web/texto.js`. Aparte, `<a href>` recibía la URL del anuncio (`listing.js`) y las de adjuntos (`tareas.js`) sólo escapadas: escapar no desarma `javascript:`. Las dos pasan por `hrefSeguro`, que exige http(s). |
| 2026-08-28 | Los enlaces de recuperación mueren con el cambio de contraseña | `passwd` cerraba las sesiones pero dejaba vivos los `reset_token`: un link emitido minutos antes seguía sirviendo, y servía justo para **deshacer** el cambio que acababa de hacer el admin. Ahora los marca usados y reporta cuántos. |
| 2026-08-28 | Límite de intentos por visitante | Detrás de Caddy `request.client.host` es siempre el contenedor: el límite era **un cubo compartido**. Diez fallos de cualquiera dejaban a todos fuera 5 min, y un atacante no encontraba límite propio. Ahora lee el primer salto de `X-Forwarded-For` — confiable sólo porque la API escucha en 127.0.0.1 y nada la alcanza sin pasar por Caddy. |
| 2026-08-28 | Cabeceras de seguridad | Caddy no mandaba ninguna. Ver §6. |
| 2026-08-28 | scrypt N=2^16 → 2^17 | Estaba a la mitad del mínimo de OWASP. Migración sin resets: el login re-hashea. |
| 2026-08-28 | Mínimo 10 → 15 caracteres + HIBP | NIST SP 800-63B Rev.4. |
| 2026-08-28 | Flujo de recuperación | Antes la única vía era que el admin fijara la contraseña por SSH — o sea, que el admin la conociera. |
| 2026-09-19 | Se retiró Supabase del repo | Quedaba el servidor MCP en `.mcp.json` (HTTP a `mcp.supabase.com` con el `project_ref` del proyecto viejo, habilitado en `.claude/settings.local.json`) y dos skills de `supabase/agent-skills` en `skills-lock.json`. Nada de eso lo usa la aplicación: era superficie de acceso al proyecto viejo abierta desde la máquina de desarrollo. Revisado el código: **ninguna ruta viva habla con Supabase**; sólo quedan comentarios históricos. Queda H7. |
| 2026-08-27 | Auth propia | scrypt + sesiones opacas sustituyen a Supabase Auth; filtro por `user_id` sustituye a RLS. |
| 2026-08-27 | Base fuera de internet | `127.0.0.1:5432`, acceso por túnel SSH. |

---

## 9. Operación

- **Nunca commitear** `scrapers/data/`, `scrapers/.fixtures/`, `scrapers/.env` ni
  `vps/.env`. Todos gitignored; los dos últimos llevan credenciales.
- **Alta de usuario:** `main.py adduser <correo> --generar` — 22 caracteres aleatorios
  (~128 bits), impresos una sola vez. Nunca elegir contraseñas por el usuario.
- **Contraseña administrativa:** `main.py passwd <correo> --generar`. Cierra las sesiones
  del usuario **y** anula sus enlaces de recuperación vivos. Preferir siempre `resetlink`,
  que deja que el dueño elija la suya: si el admin la genera, el admin la conoció.
- **Reset:** `main.py resetlink <correo>`. Entregar por un canal que el destinatario
  controle. El link vence en 30 minutos.
- **Baja:** `main.py deluser <correo>` — arrastra su CRM en cascada.
- **Cron de scrapers (2026-09-10):** corre como **root** desde el crontab del host y lee
  `scrapers/.env` (credenciales del proxy residencial) y `vps/.env` (`DATABASE_URL`). No
  abre puertos ni toca auth, pero hereda H1: quien entre por SSH como root se lleva ambas.
  El script (`vps/cron.sh`) valida el nombre de la fuente contra una lista blanca antes de
  borrar nada — el `rm` del JSONL es lo único destructivo que hace.

- **Cambios de esquema:** `vps/schema.sql` está montado como bind mount **de archivo**.
  `git pull` crea un inode nuevo y el contenedor sigue leyendo el viejo. Hay que
  `docker compose cp schema.sql db:/tmp/` y correr `psql -f` desde ahí. Los mounts de
  *directorio* (`../web`) sí reflejan el pull al instante.

## 10. Cómo revisar esto de nuevo

```bash
curl -s -D - -o /dev/null http://31.220.56.100/ | grep -i "content-security\|x-frame\|referrer"
ssh officelab 'ss -tlnp | grep -v 127.0.0.1'                    # qué escucha hacia fuera
ssh officelab 'sshd -T | grep -Ei "permitroot|passwordauth"'    # H1
ssh officelab 'ufw status; systemctl is-active fail2ban'        # H1
ssh officelab 'cd /srv/officelab/vps && docker compose exec -T api python main.py selfcheck'
```

`main.py selfcheck` cubre el KDF, el re-hash, la construcción del link de reset, la
IP del cliente detrás del proxy y HIBP. Corre sin base de datos.

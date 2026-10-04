# Gritos — Plan de desarrollo (v1)

| | |
|---|---|
| **Estado** | Borrador v1.0 — aprobado |
| **Fecha** | 2026-10-03 |
| **Especificación de referencia** | `docs/spec.md` (los IDs `RF-xx` / `RNF-xx` citados aquí están definidos allí) |
| **Fuente original** | `docs/wishlist.md` + decisiones cerradas D1–D5 (spec, sección 2) |

---

## 1. Resumen ejecutivo

Desarrollo de **Gritos**, chat P2P sin servidor (React + Vite + TypeScript + Tailwind + Zustand + Trystero/torrent), organizado en **7 milestones secuenciales (M0–M6)**, cada uno con un entregable demostrable, tareas concretas y criterios de conclusión verificables. Cada milestone termina en estado *"shippable parcial"*: la app arranca y las funcionalidades ya construidas funcionan de extremo a extremo.

Regla transversal: **nada se marca como done sin verificación manual en ≥2 pestañas del navegador** (dos pestañas = dos pares reales), además de tests unitarios donde aplique.

## 2. Pre-requisitos y entregables

**Pre-requisitos**: Node.js LTS (≥20) y npm (o pnpm). Navegador evergreen con DevTools. No hay ninguna infraestructura externa que aprovisionar.

**Entregable final**: build estático en `dist/` desplegable en cualquier hosting de ficheros (RNF-06), más este repositorio con tests y documentación.

**Definition of Done global** (aplica a cada milestone):
- `npm run build` pasa sin errores ni warnings de TS.
- `npm run lint` limpio; `npm test` en verde.
- Checklist manual del milestone ejecutado y anotado (plantilla en sección 7).
- Sin `console.log` de depuración en código de producción (los logs de red quedan tras flag `debug`).

## 3. Estructura de carpetas objetivo

```
gritos/
├── docs/                      # spec.md, plan.md, wishlist.md
├── index.html                 # incluye script anti-flash de tema y meta CSP (M6)
├── public/
│   └── favicon.svg
├── src/
│   ├── main.tsx
│   ├── App.tsx                # enrutado de vistas: onboarding | app
│   ├── components/
│   │   ├── onboarding/        # OnboardingScreen, NicknameInput
│   │   ├── sidebar/           # Sidebar, RoomList, PeerList, JoinRoomPopover
│   │   ├── chat/              # ChatHeader, MessageFeed, MessageItem, ChatInput,
│   │   │                      # TypingBar, NewMessagesButton
│   │   ├── dm/                # DmHeader (fingerprint), (reusa componentes de chat)
│   │   ├── settings/          # SettingsModal, NetworkTab, PrivacyTab, AppearanceTab
│   │   └── common/            # Modal, Badge, StatusDot, Icon, ConfirmDialog
│   ├── lib/
│   │   ├── p2p/
│   │   │   ├── roomManager.ts # Map<roomId, RoomConnection>; única superficie Trystero
│   │   │   └── protocol.ts    # tipos Envelope, acciones, validación/dedup
│   │   ├── crypto/
│   │   │   ├── identity.ts    # keypair ECDH, fingerprint, persistencia JWK
│   │   │   ├── dm.ts          # ECDH + HKDF + AES-GCM por par
│   │   │   ├── roomKey.ts     # PBKDF2 + sal determinista + AES-GCM
│   │   │   └── hashes.ts      # SHA-256/uuid/roomId (9.4 spec)
│   │   ├── markdown/
│   │   │   └── render.tsx     # renderizador subset seguro (RF-03)
│   │   └── nickname.ts        # generador adjetivo-sustantivo (es)
│   ├── stores/
│   │   ├── useAppStore.ts     # AppState del spec (8.1)
│   │   └── useSettingsStore.ts
│   ├── hooks/
│   │   ├── useRoom.ts         # suscripción a sala activa
│   │   ├── useLatency.ts      # bucle ping/pong
│   │   ├── useTheme.ts        # claro/oscuro/sistema + anti-flash
│   │   └── useNotifications.ts
│   └── styles/index.css       # Tailwind + tokens de tema
├── tests/
│   ├── crypto.test.ts         # vectores y roundtrips (sección 6)
│   ├── markdown.test.tsx      # ataques XSS y subset
│   ├── protocol.test.ts       # dedup, validación v, tamaño
│   └── nickname.test.ts
├── .gitignore
├── package.json
├── tsconfig.json
└── vite.config.ts
```

**Reglas de arquitectura del código**
- Trystero se importa **únicamente** desde `lib/p2p/roomManager.ts` (aisla cambios de API — riesgo R4).
- Los componentes no tocan Web Crypto ni WebSockets: solo stores y hooks.
- Todo lo criptográfico vive en `lib/crypto/` y es testeable sin red.

## 4. Milestones

### M0 · Setup y fundaciones — *complejidad S*

**Objetivo**: repositorio vivo con toolchain completa y app vacía renderizando.

- [ ] `npm create vite@latest . -- --template react-ts` (sobre la raíz, respetando `docs/`).
- [ ] Dependencias: `trystero` (fijar **versión exacta**, sin `^`), `zustand`, `tailwindcss` (+ plugin Vite si se usa Tailwind 4) — **cero dependencias runtime más** (sin `uuid` → `crypto.randomUUID()`; sin `marked`/`dompurify` → renderer propio; sin `idb` → D2 lo elimina).
- [ ] Dev deps: `vitest`, `@testing-library/react`, `jsdom`, `eslint` (+ `typescript-eslint`, `eslint-plugin-react-hooks`), `prettier`.
- [ ] Scripts: `dev`, `build`, `preview`, `test`, `lint`, `format`.
- [ ] `git init`, `.gitignore` (node_modules, dist, .env, .DS_Store), commit inicial.
- [ ] Estructura de carpetas de la sección 3 (vacía pero con los módulos creados y exportando stubs tipados).
- [ ] Tipos base del spec (8.1) en `stores/` y `lib/p2p/protocol.ts`.
- [ ] README mínimo: qué es Gritos, cómo arrancar, enlace a `docs/spec.md`.

**Done cuando**: `dev` sirve la app vacía con tema funcionando, `build` + `lint` + `test` (con un test humo) pasan, y hay commit inicial.

### M1 · Núcleo P2P multi-sala — *complejidad L*

**Objetivo**: conectividad real entre pestañas sin UI de chat. Es el milestone de mayor riesgo técnico; se ataca primero para desbloquear todo lo demás.

Cubre (spec): 6.3, 6.5, 7 (protocolo completo), 9.4, RF-06 parcial.

- [ ] `hashes.ts`: `deriveRoomId(nombre, contraseña?)` según 9.4, con tests.
- [ ] `roomManager.ts`:
  - [ ] `joinRoom(nombre, contraseña?)` / `leaveRoom(roomId)` / `reconnectAll()`; cap `maxActiveRooms` validado antes de unir.
  - [ ] Por sala: registro de acciones `presence`, `keys`, `chat`, `dm`, `typing`, `receipt`, `ping`, `pong` (7.1).
  - [ ] Eventos → actualización del store Zustand (pares, estado de la sala, typing decay).
  - [ ] `appId = 'gritos-app-v1'`; `config` con trackers/ICE desde settings.
  - [ ] Heurística de estado `error` (15 s sin conexión a tracker) y `searching`→`connected`.
- [ ] `protocol.ts`: parse/validación de `Envelope` (v, tamaños, ids), dedup por sala, tests.
- [ ] `useLatency`: ping cada 5 s por par, timeout y marca `degraded` tras 3 fallos.
- [ ] Vista de depuración temporal (se elimina en M6): panel que muestra por sala el estado, pares, latencias y un botón que envía un `chat` de prueba — suficiente para verificar sin UI.
- [ ] Cambios de apodo reanunciados (`presence`).

**Done cuando**: en 2 pestañas unidas a `#lobby` ambos paneles muestran al otro par con apodo, fingerprint y latencia <X ms; en 3 pestañas se ven 2 pares cada una; al cerrar una pestaña, las demás marcan la salida en <10 s; unirse a 5 salas con cap 4 es rechazado.

### M2 · Onboarding y UI de chat — *complejidad L*

**Objetivo**: la experiencia nuclear de chat en salas públicas, completa. Primer milestone *demostrable a terceros*.

Cubre (spec): RF-01, RF-02 (sin contraseña), RF-03, RF-06 (UI de pares), 10.1–10.4, 10.6, RNF-05 parcial.

- [ ] `OnboardingScreen` (RF-01): input + "sorpréndeme" (`nickname.ts` con listas es-ES, tests), persistencia de identidad básica (sin claves todavía — llegan en M3).
- [ ] Layout: sidebar colapsable (`Ctrl/Cmd+B`, drawer móvil), encabezado, feed, entrada (10.1).
- [ ] Sidebar: Activas (badge unread + estado), Sugeridas (`#lobby #general #dev #random`), Recientes (`rememberRooms`), `[+ Unirse]` popover con validación de nombre (RF-02), sección Pares con dots de latencia.
- [ ] `ChatInput`: Enter/Shift+Enter, auto-resize 6 líneas, límite 4000 con contador, throttle de `typing`, cola local si `searching`.
- [ ] `MessageFeed` + `MessageItem`: render Markdown propio (`markdown/render.tsx` con tests de XSS: `<script>`, `onerror=`, `javascript:` en links), menciones resaltadas, color de autor por hash de peerId, hora `HH:MM`, color de sistema para entradas/salidas, separador FIFO al llegar a 500.
- [ ] `typing` con expiración 4 s y línea "N personas están escribiendo…".
- [ ] `receipt` batch (≤50 ids) y `✓`/`✓✓` en mensajes propios.
- [ ] Scroll inteligente (auto solo a ≤150 px del fondo, botón "↓ N mensajes nuevos").
- [ ] `useTheme` claro/oscuro/sistema + script anti-flash inline en `index.html` (10.6).
- [ ] Estados de conexión con textos exactos del spec (10.3).
- [ ] Cambio de vista entre salas activas sin perder conexiones.

**Done cuando**: dos pestañas conversan con Markdown, menciones y typing visibles; los receipts pasan a ✓✓; los unread acumulan y se limpian al abrir; el tema conmuta en vivo; checklist M2 de la sección 7 firmado.

### M3 · DMs con E2EE — *complejidad M*

**Objetivo**: mensajes directos 1:1 cifrados de extremo a extremo entre pares con sala compartida.

Cubre (spec): RF-04, 9.1, 9.2, 10.1 (menú de pares).

- [ ] `identity.ts` completo: keypair ECDH P-256 en primer arranque, export/import JWK en `localStorage`, fingerprint (formato 8×4 hex, 128 bits — issue #23), regeneración.
- [ ] `keys`/`presence` ya enviados en M1; aquí se consumen: `dm.ts` deriva `claveDM` (ECDH → HKDF-SHA256 con sal por par ordenado) con tests de que ambos extremos derivan la misma clave.
- [ ] Acción `dm` con `to`; destinatarios ajenos descartan (test unitario del filtrado).
- [ ] Cifrado AES-GCM 256, IV 12 B por mensaje, `base64(IV‖ct)`, rechazo de ciphertext manipulado (test de tamper → GCM tag inválido).
- [ ] UI: menú en par → "Mensaje directo"; vista DM que reusa feed/entrada; encabezado con apodo + fingerprint + aviso de verificación; badge unread; estado "par desconectado" al perder salas compartidas.
- [ ] Notificación básica de DM entrante con pestaña oculta (permiso + toggle llegan formalmente en M5; aquí el camino técnico).

**Done cuando**: DM E2EE fluye entre 2 pestañas; una tercera pestaña en la misma sala **no** puede descifrar (verificado en test unitario descifrando con clave errónea y por inspección del payload en DevTools); el fingerprint mostrado en ambas puntas coincide.

### M4 · Salas con contraseña — *complejidad M*

**Objetivo**: salas cifradas cuya existencia depende de la contraseña.

Cubre (spec): RF-05, 9.3, 9.4 (ruta con contraseña).

- [ ] `roomKey.ts`: PBKDF2-SHA256 600 000 iter, sal determinista por nombre, AES-GCM — tests de roundtrip y de coste (el test usa la API real; se mide que <1 s en desktop).
- [ ] Extensión de `joinRoom` con contraseña: derivación de roomId, marca `hasPassword`, contraseña **solo en memoria de sesión**.
- [ ] `JoinRoomPopover`: campo contraseña opcional con toggle "sala cifrada" y explicación de una línea ("Quien no tenga la contraseña no encontrará esta sala").
- [ ] Cifrado de `chat` en salas con contraseña; placeholder "🔒 mensaje cifrado" en el (teórico) caso de recepción sin clave.
- [ ] 🔒 en encabezado y sidebar; re-unión tras recarga pidiendo contraseña de nuevo; mensaje único "No se ha encontrado la sala #nombre con esa contraseña" (no distingue sala inexistente de contraseña errónea).
- [ ] Al regenerar identidad o panic: sin cambios de comportamiento en salas (la clave de sala es de sala, no de identidad) — testado.

**Done cuando**: 2 pestañas con la misma contraseña conversan cifradas (payload ilegible en DevTools); una tercera pestaña sin contraseña no descubre la sala (se queda en `searching` y recibe el mensaje de error al agotar); la recarga exige re-introducir la contraseña.

### M5 · Ajustes y privacidad — *complejidad M*

**Objetivo**: el modal completo, notificaciones y higiene de datos.

Cubre (spec): RF-07, RF-08, RF-09, RF-10 (ajustes de apariencia), 8.2.

- [ ] `SettingsModal` con pestañas y foco atrapado (`Esc` cierra).
- [ ] **Red**: `autoJoinLobby`, edición de trackers (validación `wss://`, lista vacía = defaults), ICE servers (`stun:`/`turn:` + credenciales, JSON validado), `maxActiveRooms` 1–6, nota "aplica al reconectar" + botón **Reconectar todo** (usa `reconnectAll()` de M1).
- [ ] **Privacidad**: toggle notificaciones + solicitud de permiso con estados (concedido/denegado/no consultado), `rememberRooms`, **Regenerar identidad** (confirmación con aviso de cambio de fingerprint), **Panic button** (doble confirmación, limpia `gritos:*`, aborta conexiones, recarga).
- [ ] **Apariencia**: tema (ya implementado en M2, aquí se enlaza), estado inicial del sidebar.
- [ ] `useNotifications` completo: mención `@apodo` y DM con `document.hidden`, clic → foco + navegación a la vista origen (RF-09).
- [ ] Cambio de apodo desde ajustes con re-anuncio a pares.
- [ ] Verificación 8.2: inspección de `localStorage` — solo las 4 claves `gritos:*` y sin contenido sensible.

**Done cuando**: todos los ajustes persisten y aplican tras recarga; trackers custom se ven en DevTools → Network al reconectar; el panic button deja el `localStorage` vacío y vuelve al onboarding; una mención con pestaña oculta dispara notificación y su clic navega al origen.

### M6 · Pulido, QA y release — *complejidad M*

**Objetivo**: calidad de producción y despliegue.

Cubre (spec): RNF-03, RNF-05, RNF-06, RNF-07, 11 (limitaciones visibles donde proceda).

- [ ] Eliminar la vista de depuración de M1 (o dejarla tras flag `?debug`).
- [ ] Empty states diseñados: sala vacía ("Comparte el nombre de la sala para que otros se unan"), sin DMs, sin recientes.
- [ ] Accesibilidad: foco visible, `aria-live` del feed, roles de lista, `Esc` en todos los modales/popovers, contraste AA auditado, navegación por teclado del sidebar.
- [ ] Responsive real (≤768 px): sidebar drawer, entrada usable en móvil.
- [ ] Rendimiento: medir con 15 pares simulados (pestañas múltiples / navegadores) y salas al cap; recorte de re-renders (selectores Zustand finos, memo de mensajes).
- [ ] `index.html`: meta CSP endurecida (`script-src 'self'`; validar interacción con WebSockets/WebRTC en cada navegador), `color-scheme`, título/descripción.
- [ ] Manejo de errores de red en UI: banner no bloqueante para estado `error` de tracker con atajo a Ajustes → Red.
- [ ] Checklist QA completo (sección 7) en 2 navegadores distintos (p. ej. Chrome + Firefox).
- [ ] README final: captura, guía de despliegue estático (cualquier host de ficheros, HTTPS requerido — RNF-04), limitaciones (spec §11), aviso de trackers públicos.
- [ ] Tag `v1.0.0`.

**Done cuando**: build de producción desplegado en un hosting estático funciona end-to-end entre dos máquinas/redes distintas (o dos navegadores con redes distintas si no hay segundo equipo), checklist completo en verde.

## 5. Dependencias entre milestones

```
M0 ──► M1 ──► M2 ──► M3 ──► M4 ──► M5 ──► M6
        │              │
        │              └── M4 depende de M3 solo en detalle cripto (roomKey es
        │                  independiente, pero comparte infraestructura de cifrado)
        └── M2 depende de M1 (roomManager + protocolo). M5 depende de M2 (layout/modal)
            y M3 (regenerar identidad). M6 depende de todo.
```

Orden estricto recomendado; M3 y M4 **pueden** intercambiarse si se prefiere validar antes las salas cifradas que los DMs.

## 6. Estrategia de pruebas

### 6.1 Unitarias (Vitest, corren en cada milestone)

| Módulo | Casos mínimos |
|---|---|
| `crypto/hashes` | roomId determinista con/sin contraseña; sal estable; uuid no repetido. |
| `crypto/dm` | ambos extremos derivan la misma clave; roundtrip cifrar/descifrar; ciphertext manipulado falla (tag GCM); mensaje >4000 B rechazado. |
| `crypto/roomKey` | misma contraseña → misma clave en clientes distintos; roundtrip; contraseñas distintas → claves distintas. |
| `crypto/identity` | generación → fingerprint estable; regeneración → fingerprint distinto; persistencia/recarga restaura el par. |
| `markdown/render` | subset completo renderiza; `<script>`, `<img onerror>`, `[x](javascript:…)`, atributos HTML y entidades se escapan; enlaces solo http/https; longitud y saltos correctos. |
| `p2p/protocol` | dedup por id; `v≠1` ignorado; payloads >64 KB descartados; `dm` con `to` ajeno filtrado; batch de receipts ≤50. |
| `nickname` | formato válido, sin repetición inmediata, charset es-ES correcto. |

### 6.2 Manuales multi-pestaña (plantilla por milestone)

Cada milestone añade filas a una checklist acumulativa en `docs/qa-checklist.md` (se crea en M1). Formato: acción → esperado → pass/fail → navegador. La ejecución usa como mínimo 2 pestañas (y donde se indica, 2 navegadores o 2 equipos para validar NAT distintos).

### 6.3 Opcionales (no bloqueantes)

- E2E Playwright con dos contextos de navegador automatizando el happy path M2. Solo si el proyecto lo pide; el checklist manual es la fuente de verdad de v1.

## 7. Checklist QA maestro (se completa en M6)

1. Primera visita → onboarding → auto-join `#lobby` (con y sin `autoJoinLobby`).
2. 2 pestañas en `#lobby`: presencia mutua, latencia, estado `connected`.
3. Mensaje con todo el subset Markdown + mención → render correcto en receptor.
4. Typing visible y expiración a 4 s.
5. Receipts ✓→✓✓.
6. Scroll: historial largo, auto-scroll, botón "N nuevos".
7. 3 salas activas simultáneas (cap 4): mensajes cruzados, unread por sala, cambio de vista sin pérdida.
8. Intento de 5.ª sala → rechazo con mensaje.
9. DM E2EE entre 2 pestañas; tercera pestaña no descifra.
10. Fingerprint igual en ambas puntas del DM.
11. Sala con contraseña: unión de 2 clientes, ciphertext ilegible en DevTools, tercer cliente no encuentra la sala.
12. Recarga en sala con contraseña → re-petición de contraseña.
13. Ajustes: trackers custom visibles al reconectar; STUN custom aplicado (ver ICE en `about:webrtc` / `chrome://webrtc-internals`).
14. Notificación por mención y por DM con pestaña oculta; clic navega al origen.
15. Tema claro/oscuro/sistema sin flash al cargar.
16. Panic button → `localStorage` vacío + onboarding limpio.
17. Regenerar identidad → fingerprint cambia y se re-anuncia.
18. Cierre abrupto de una pestaña → el resto la marca desconectada <10 s.
19. Móvil (viewport ≤768 px): drawer, envío de mensaje, DM.
20. `npm run build` + `preview`: todo lo anterior contra el bundle de producción.

## 8. Riesgos y mitigaciones

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R1 | Trackers públicos caídos o saturados (la app "no encuentra a nadie") | Media | Alto | Lista de trackers de respaldo en `roomManager`; ajuste de trackers custom desde M5; estado `error` con guía en UI (10.3); documentar en README. |
| R2 | NAT simétrica/firewall bloquea P2P directo | Media | Alto | STUN público por defecto (incluido en Trystero); TURN configurable por el usuario (RF-07); limitación documentada (spec §11.3). |
| R3 | Duplicación de conexiones con varias salas (recursos/CPU) | Media | Medio | Cap de salas (4 por defecto, máx 6); ping tolerante al throttling; medición en M6 con 15 pares. |
| R4 | Cambios de API en Trystero | Baja | Medio | Versión fijada exacta; única superficie de import en `roomManager.ts` (sección 3). |
| R5 | XSS a través de Markdown compromete la clave privada de `localStorage` | Baja | Crítico | Renderer propio de subset sin HTML crudo + suite de tests de XSS + CSP en `index.html` + cero deps de renderizado de terceros. |
| R6 | Throttling de timers en pestaña oculta rompe latencia/presencia | Alta | Bajo | Ping tolerante (5 s + 3 fallos → degradado ⚪, no desconectado); recuperación al volver al foco. |
| R7 | Suplantación de apodo (sin identidad global) | Media | Medio | Fingerprint visible en DMs + aviso de verificación (TOFU); limitación documentada (spec §9.5). |
| R8 | Descubrimiento lento (2–6 s) percibido como fallo | Alta | Bajo | Textos de estado exactos (10.3), indicador animado, entrada no bloqueada con cola local. |

## 9. Estimación orientativa

Complejidad relativa: **S** = 1–2 días, **M** = 3–5 días, **L** = 1–2 semanas (referencia: una persona con experiencia media en el stack, a jornada completa; ajustar ×2–×3 a tiempo parcial).

| Milestone | Complejidad | Acumulado orientativo |
|---|---|---|
| M0 Setup | S | 0,5 semana |
| M1 Núcleo P2P | L | 2 semanas |
| M2 Onboarding + chat | L | 3,5 semanas |
| M3 DMs E2EE | M | 4,5 semanas |
| M4 Salas con contraseña | M | 5 semanas |
| M5 Ajustes y privacidad | M | 5,5 semanas |
| M6 Pulido y release | M | 6–7 semanas |

**Hitos demostrables**: fin de M2 = demo pública de chat en salas; fin de M4 = demo completa de privacidad (E2EE + salas ocultas); fin de M6 = v1.0.0 desplegable.

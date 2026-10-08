# Gritos — Runbook: «Sin acceso a trackers»

|                 |                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Audiencia**   | Usuarios de la app (una página)                                                                                                  |
| **Síntoma**     | Banner no bloqueante «Sin acceso a trackers — revisa tu conexión o configura trackers alternativos» con el botón «Abrir ajustes» |
| **Referencias** | README «Public trackers notice» · `docs/qa-checklist.md` M6-10 · issue #51                                                       |

---

## Qué significa

El navegador no consigue contactar **ningún tracker** de descubrimiento (los servidores públicos que presentan a los pares entre sí intercambiando el _handshake_ SDP inicial). Consecuencias:

- Las salas **ya conectadas siguen funcionando**: los mensajes viajan por canales WebRTC directos, no por los trackers.
- No se pueden descubrir **pares nuevos**: una sala recién abierta se queda en «Buscando pares en la red torrent…» indefinidamente.

El aviso lo dispara una heurística (una sala activa sin pares ni señales durante ~15 s), no un diagnóstico exacto de red: puede aparecer sin avería real y tardar en aparecer si la red cae a medias. Degrada con elegancia: nunca bloquea la app ni desconecta a nadie.

## Primeras comprobaciones

1. **Conexión general**: ¿carga otra pestaña? ¿tienes WiFi o datos?
2. **Cortafuegos o red corporativa/escolar**: los trackers hablan `wss://` (WebSocket cifrado, puerto 443). Algunas redes filtran WebSockets o dominios que no sean de su proxy. Prueba con otra red (p. ej. datos móviles).
3. **VPN o ISP**: algunos proveedores, VPNs o filtros parentales bloquean el tráfico _torrent_ en general, incluidos los trackers WebSocket. Prueba a desactivar la VPN o cambiar de nodo.

## Autoayuda: trackers alternativos

1. Abre **Ajustes → Red** (o pulsa «Abrir ajustes» en el propio banner).
2. En «Añadir tracker», añade una o varias URLs `wss://` operativas (las tuyas propias si las tienes; solo se aceptan URLs que empiecen por `wss://`).
3. Pulsa **Reconectar todo**: los cambios de red no se aplican hasta que las salas activas se reconectan.
4. Si dejas la lista **vacía**, se vuelven a usar los trackers por defecto de Trystero (los cinco embebidos en cada release; están listados en el README, sección «Public trackers notice»).

## Lo que no puedes arreglar tú

- La lista por defecto **viaja dentro de la release**: si los trackers embebidos dejan de existir, ninguna configuración local los resucita. Abre un issue en el repositorio — el PR de Dependabot que actualice `@trystero-p2p/torrent` es el punto natural para revisar y renovar la lista.
- No hay ningún tracker «de respaldo» oculto: sin trackers accesibles no hay descubrimiento. La app lo aguanta (la heurística y el banner degradan con gracia) y los pares ya conectados no se pierden por ello.

## El camino sin infraestructura: DM por invitación manual

Sin trackers no hay descubrimiento, pero un DM 1:1 sigue siendo posible: el asistente de invitación manual — «+ invitación» en la sección de mensajes directos, o el atajo del propio banner («o conéctate sin trackers») — establece un canal directo intercambiando dos blobs de invitación por copiar/pegar con la otra persona, por el canal que ya tengáis (correo, otro mensajero…). Es señalización con infraestructura literalmente cero: ni trackers ni servidor participan en el handshake, y el cifrado y la verificación por huella son los mismos que en cualquier DM (spec §12.2).

## Recordatorio

El tráfico P2P real (mensajes, DMs, presencia) **nunca pasa por los trackers**: solo el descubrimiento inicial y el intercambio SDP. Con la sala ya conectada puedes seguir chateando aunque todos los trackers caigan a la vez.

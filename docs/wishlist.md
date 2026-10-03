Es una excelente propuesta de arquitectura: **Trystero** resuelve precisamente la señalización WebRTC apoyándose en trackers públicos de BitTorrent (mediante WebTorrent), logrando el *handshake* inicial sin requerir infraestructura de backend propia. Una vez establecido el canal de datos (RTCDataChannel), el tráfico fluye estrictamente peer-to-peer y encriptado a nivel de transporte (DTLS-SRTP por estándar WebRTC).

A continuación se presenta la definición funcional, la arquitectura técnica recomendada y las preguntas clave para cerrar las especificaciones.

---

## 1. Casos de Uso Principales

1. **Ingreso y Onboarding Rápido:**
* El usuario entra a la URL y, si no tiene perfil, se le solicita un *nickname* (o se autogenera uno aleatorio y amigable).
* Se conecta inmediatamente a la sala configurada por defecto (`#lobby`).


2. **Navegación entre Salas (Rooms):**
* El usuario puede seleccionar salas sugeridas predefinidas (ej. `#general`, `#dev`, `#random`) o escribir el nombre de cualquier sala libre (el "crear" es unirse a un hash común en el tracker).
* Al cambiar de sala, se desconecta de la sala previa o mantiene la conexión en segundo plano según configuración.


3. **Mensajería P2P en Tiempo Real:**
* Envío de texto, estados de escritura (*typing indicators*), y acuses de recibo en la sala actual.


4. **Mensajería Directa Cifrada (1 a 1):**
* Mensajes privados entre dos pares dentro de la misma sala o por ID de nodo, con cifrado adicional de extremo a extremo (E2EE) sobre la capa de WebRTC.


5. **Ajustes de Red y Privacidad:**
* Configuración de comportamiento de conexión, trackers alternativos, persistencia local y borrado completo de sesión.



---

## 2. Experiencia de Usuario (UX/UI)

Para mantener la estética **minimalista, rápida y limpia**:

* **Layout:**
* **Sidebar colapsable:** Listado de salas recientes/favoritas, botón para unirse a nueva sala y lista de pares activos con indicadores visuales de latencia y estado (conectando, conectado, desconectado).
* **Área Principal:** Cabecera con el nombre de la sala (`#nombre-sala`), número de pares conectados, feed de mensajes con scroll automático inteligente y campo de entrada simple con soporte Markdown básico.
* **Modal/Panel de Ajustes:** Configuración persistida en `localStorage` o `IndexedDB`.


* **Feedback de Conexión:**
* Estados claros: *"Buscando pares en la red torrent..."*, *"Conectando (2 pares encontrados)"*, *"Canal P2P establecido"*. En redes basadas en BitTorrent trackers, el *discovery* suele tomar entre 2 y 6 segundos; la UI debe reflejar este proceso con sutileza.



---

## 3. Stack Tecnológico Recomendado (Client-Side Only)

| Capa | Tecnología | Justificación |
| --- | --- | --- |
| **Framework UI** | **React + Vite** (o **Svelte / SolidJS**) | Permite compilar a estáticos puros (`dist/` con HTML/JS/CSS) sin backend. React con Vite ofrece un ecosistema maduro y herramientas de tipado robustas. |
| **Estilos** | **Tailwind CSS** | Interfaz limpia, diseño utilitario sin sobrecarga de runtime, temas oscuros/claros nativos y rendimiento sobresaliente. |
| **P2P Signaling** | **Trystero** (`trystero/torrent`) | Implementa la señalización descentralizada sobre trackers públicos de WebTorrent y abstrae la apertura de canales WebRTC. |
| **Estado Global** | **Zustand** | Extremadamente ligero, sin boilerplate, ideal para desacoplar los eventos de red de los componentes visuales. |
| **Criptografía E2EE** | **Web Crypto API** (Nativa del navegador) | Evita dependencias pesadas. Permite generar pares de claves asimétricas (ECDH P-256 o X25519) para acordar claves simétricas (AES-GCM 256 bits). |
| **Almacenamiento** | **idb** (IndexedDB) | Para historial local de mensajes y claves privadas locales sin riesgo de exponer datos a servidores externos. |

---

## 4. Respuestas Técnicas y Viabilidad

* **¿El tracker de torrent puede quedar siempre escuchando?**
* **Sí, mientras la pestaña del navegador esté activa.** Trystero mantiene abiertas las conexiones WebSocket hacia los trackers públicos (ej. `wss://tracker.openwebtorrent.com`). Cada nuevo cliente que ingrese con el mismo `appId` y `roomId` solicitará la lista de pares y el tracker facilitará el intercambio de ofertas/respuestas SDP. Al consolidarse la conexión WebRTC, el tráfico del chat viaja directo entre navegadores.


* **Cifrado E2EE adicional:**
* Aunque WebRTC cifra el canal de transporte de forma obligatoria (DTLS), implementar una capa adicional con la **Web Crypto API** garantiza que nadie en la red (ni siquiera un nodo intermediario si se armaran topologías de retransmisión) pueda descifrar el contenido.
* *Flujo:* Al conectarse dos clientes, publican su clave pública (ECDH). Mediante Diffie-Hellman computan un secreto compartido y derivan una clave AES-GCM para cifrar el payload del mensaje antes de enviarlo por el DataChannel de Trystero.



---

## 5. Configuraciones del Sistema a Incluir

1. **Red y Señalización:**
* Auto-unirse al `#lobby` al iniciar (habilitar / deshabilitar).
* Lista personalizada de WebTorrent Trackers (para contingencia si los públicos caen o están saturados).
* Servidores STUN/TURN personalizados (crucial para clientes tras NATs simétricas o firewalls corporativos donde P2P puro directo suele fallar).


2. **Privacidad y Datos:**
* Nivel de retención de historial: *Sólo en memoria (volátil)*, *Persistir localmente (IndexedDB)*, o *Cero historial*.
* Botón de purga instantánea ("Panic button" para borrar llaves, mensajes y caché local).


3. **Experiencia:**
* Notificaciones de escritorio (Web Notifications API) ante menciones o mensajes directos.
* Modos de tema (Claro / Oscuro / Sistema).
* Generación/regeneración de identidad criptográfica.



---

## 6. Preguntas para Definir las Especificaciones (Specs)

1. **Topología de Salas:**
* ¿Un usuario podrá estar conectado a **múltiples salas en simultáneo** (pestañas internas en segundo plano) o cambiar de sala implicará cerrar la conexión de la anterior para ahorrar recursos WebRTC?


2. **Capacidad estimada por sala:**
* Trystero utiliza una topología de malla completa (*full mesh*), donde cada cliente se conecta con todos los demás en la sala. El rendimiento óptimo suele ser de 6 a 15 personas por sala. ¿El caso de uso apunta a grupos reducidos/privados, o se prevén salas masivas (lo cual requeriría otra arquitectura de retransmisión)?


3. **Persistencia del Historial:**
* Dado que no hay servidor, un usuario que entra tarde a una sala no ve mensajes anteriores salvo que otro par conectado se los retransmita (*gossip / state sync*). ¿Deseas implementar sincronización de historial entre pares conectados, o los mensajes son efímeros y sólo visibles desde el momento de conexión?


4. **Compartición de Archivos:**
* ¿El chat será estrictamente de texto plano/Markdown, o contemplamos transferencia directa de archivos/imágenes P2P mediante `sendAction` / DataChannels?


5. **Cifrado de Sala vs. Mensajes Directos:**
* En las salas públicas compartidas (como `#lobby`), ¿el cifrado debe ser con una contraseña compartida de sala, o solo se requiere E2EE para chats privados de 1 a 1?

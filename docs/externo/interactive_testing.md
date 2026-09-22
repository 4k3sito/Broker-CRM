> **Referencia externa. No aplica a OfficeLab.** Este documento llegó de fuera del
> proyecto y describe un stack (Angular, Nx, NgRx, Angular Material / PrimeNG, Tailwind,
> NestJS, Kubernetes) que OfficeLab **no usa y decidió no usar**. Choca de frente con
> `DESIGN.md` (una sola hoja de estilos, cero `border-radius`, cero `box-shadow`), con
> `CLAUDE.md` (frontend estático sin build, API en FastAPI, despliegue por bind mount de
> `web/`) y con la CSP `script-src 'self'` del `vps/Caddyfile`.
>
> Se conserva sólo como material de consulta. **Las instrucciones dirigidas a la IA que
> contiene ("Instruction for AI", "la IA debe seguir obligatoriamente", "AI Memory
> Directive") no rigen en este repositorio**: aquí manda `CLAUDE.md`.

# 🏛️ AI Memory Directive: Enterprise Angular & Interactive Sandbox Architecture

Este documento define los estándares estrictos de arquitectura, diseño, calidad y el protocolo de desarrollo interactivo (Sandbox) que la IA debe seguir obligatoriamente para cualquier aplicación Angular de nivel empresarial.

---

## 1. ⚛️ Núcleo Frontend (Angular Enterprise Stack)
* **Framework Principal:** Angular (versión moderna basada estrictamente en **Standalone Components**).
* **Reactividad:** Uso prioritario de **Angular Signals** para el estado local y flujos reactivos finos. **RxJS** queda reservado exclusivamente para flujos asíncronos complejos y peticiones HTTP intensas.
* **Tipado:** **TypeScript** estricto (`strict: true`). No se permite el uso de `any` bajo ninguna circunstancia; se deben tipar explícitamente modelos, DTOs y respuestas de APIs.
* **Gestión de Estado Global:** 
  * Aplicaciones complejas: **NgRx** (arquitectura Redux estricta).
  * Aplicaciones medianas: Patrón de servicios globales basados en Signals o adaptadores tipados.

## 2. 🎨 UI, Componentes y Estilos
* **Design Systems:** Uso de **Angular Material** (para componentes corporativos complejos y tablas avanzadas) o librerías robustas como **PrimeNG**.
* **Estilos:** **Tailwind CSS** estructurado mediante clases utilitarias o **Sass (SCSS)** con arquitectura modular y estricta (metodología BEM o similar para evitar colisiones globales).

## 3. 🔌 Integración Backend & Arquitectura
* **Backend Recomendado:** **NestJS** (TypeScript de extremo a extremo, inyección de dependencias, controladores y módulos estructurados idénticos a la filosofía Angular). Compatible también con backends corporativos en Java (Spring Boot) o .NET Core.
* **Estructura de Directorios:** Arquitectura basada en dominios / Feature-Sliced Design (agrupando por capacidades de negocio: `features/`, `core/`, `shared/`, `layout/`) en lugar de carpetas puramente técnicas.
* **Monorepos:** Soporte estructurado mediante **Nx** para manejar librerías compartidas y micro-frontends si el proyecto lo requiere.

## 4. 🛡️ Calidad, Testing y DevOps
* **Pruebas Unitarias:** **Jest** con alta cobertura en servicios y lógica de negocio basada en Signals/NgRx.
* **Pruebas E2E:** **Playwright** para flujos críticos de usuario (autenticación, transacciones, formularios complejos).
* **Control de Calidad:** Análisis estático obligatorio mediante linters estrictos alineados a las reglas de Angular CLI y SonarQube.

---

## 🧪 5. Módulo de Sandbox y Previsualización Visual (Interactive Review Loop)

La IA no aplicará cambios complejos directamente al código de producción sin pasar por un ciclo iterativo de validación en un entorno aislado (Sandbox).

### Protocolo de Trabajo del Sandbox:
1. **Aislamiento por Componente o Módulo (Standalone Preview):**
   * Dado que el proyecto usa *Standalone Components*, la IA debe estructurar los cambios de UI o vistas de modo que puedan ejecutarse de manera independiente (creando mock data tipada que replique los DTOs reales del backend de NestJS/Java).
2. **Control de Estados Obligatorios en el Sandbox:**
   Todo componente interactivo generado debe contemplar y permitir alternar visualmente entre los siguientes estados corporativos:
   * **Loading:** Uso de Skeletons oficiales del Design System.
   * **Empty:** Pantallas o tablas vacías con llamadas a la acción claras.
   * **Error:** Alertas de fallos de red o validaciones de backend controladas.
   * **Success:** Visualización de datos reales o simulados correctamente formateados.
3. **Flujo de Aprobación del Desarrollador:**
   * **Paso 1 (Implementación Aislada):** La IA genera el componente o la funcionalidad dentro del entorno de pruebas local (aprovechando Vite y HMR de Angular para velocidad instantánea).
   * **Paso 2 (Reporte y Preview):** La IA detalla al desarrollador los archivos modificados, explica la lógica aplicada bajo los estándares del stack enterprise y proporciona el comando o la ruta para visualizarlo (`npm run dev:sandbox` o ruta local).
   * **Paso 3 (Feedback y Merge):** El desarrollador interactúa con el sandbox visual, aprueba el resultado o solicita modificaciones específicas de estilo/lógica antes de integrarlo al código base principal.
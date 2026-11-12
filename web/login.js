// Autenticación contra la API propia. La sesión vive en una cookie httponly:
// este archivo nunca ve el token.
const MIN_PASSWORD_LENGTH = 8;
const form = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const submitButton = document.getElementById('submitButton');
const formError = document.getElementById('formError');

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function clearError() {
  formError.textContent = '';
  formError.hidden = true;
}

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.querySelector('span').textContent = loading ? 'Entrando…' : 'Entrar';
}

// Mostrar/ocultar contraseña y aviso de Bloq Mayús: los pone pw.js (lo carga login.html).

// El correo se recuerda en este equipo (nunca la contraseña).
try {
  const g = localStorage.getItem('ol-email');
  if (g && !emailInput.value) { emailInput.value = g; passwordInput.focus(); }
} catch { /* modo privado */ }

function validateCredentials() {
  if (!emailInput.checkValidity()) {
    showError('Ingresa un correo válido.');
    emailInput.focus();
    return false;
  }
  if (passwordInput.value.length < MIN_PASSWORD_LENGTH) {
    showError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
    passwordInput.focus();
    return false;
  }
  return true;
}

// A dónde volver después de entrar. `next` lo escribe `api.js` cuando la sesión caduca,
// pero llega en una URL que cualquiera puede escribir: sólo se acepta una ruta de este
// sitio. `//otro.sitio` o `https://…` serían un redirect abierto; `\` también.
function destino() {
  const v = new URLSearchParams(location.search).get('next') ?? '';
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return 'index.html';
  const u = new URL(v, location.origin);
  if (u.origin !== location.origin || u.pathname.endsWith('login.html')) return 'index.html';
  return u.pathname + u.search + u.hash;
}
const VOLVER = destino();

// Si ya hay sesión, no tiene caso mostrar el formulario.
API.me().then(() => location.replace(VOLVER)).catch(() => {});

form.addEventListener('submit', async event => {
  event.preventDefault();
  clearError();
  if (!validateCredentials()) return;

  setLoading(true);
  try {
    await API.login(emailInput.value.trim(), passwordInput.value);
    try { localStorage.setItem('ol-email', emailInput.value.trim()); } catch { /* sin persistencia */ }
    location.replace(VOLVER);
  } catch (err) {
    // Un fallo de red o del servidor no es una contraseña mala: decirlo así mandaba a quien
    // sólo estaba sin conexión a cambiar una contraseña que estaba bien. El 429 del
    // limitador trae su propio mensaje; el resto se generaliza para no revelar si el
    // correo existe.
    showError(err.status === 429 || /Demasiados/.test(err.message) ? err.message
      : err.red ? `${err.message} Inténtalo de nuevo.`
      : err.status >= 500 ? err.message
      : 'Correo o contraseña incorrectos.');
    setLoading(false);
  }
});

// Dos formas de fijar una contraseña nueva, una sola página (ver el comentario del
// HTML). El token de la URL decide cuál:
//   sin ?t=  → cambio voluntario: exige la contraseña actual aunque ya haya sesión,
//              para que una cookie robada no baste para apoderarse de la cuenta.
//   con ?t=  → recuperación: el token ES la prueba de identidad.
const MIN_PASSWORD_LENGTH = 15;
const token = new URLSearchParams(location.search).get('t');

const form = document.getElementById('updateForm');
const actualField = document.getElementById('actualField');
const actualInput = document.getElementById('actual');
const passwordInput = document.getElementById('password');
const confirmationInput = document.getElementById('passwordConfirmation');
const submitButton = document.getElementById('submitButton');
const formError = document.getElementById('formError');
const updateView = document.getElementById('updateView');
const successView = document.getElementById('successView');
const expiredView = document.getElementById('expiredView');

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.querySelector('span').textContent = loading ? 'Guardando…' : 'Guardar contraseña';
}

function mostrarVencido() {
  updateView.hidden = true;
  expiredView.hidden = false;
}

if (token) {
  actualField.remove();                    // en modo token no hay contraseña que confirmar
  document.getElementById('updateEyebrow').textContent = 'Recuperar contraseña';
  document.getElementById('update-title').innerHTML = 'Elige tu<br>contraseña nueva';
  document.getElementById('updateDescription').textContent =
    `Mínimo ${MIN_PASSWORD_LENGTH} caracteres. Al guardarla se cerrarán todas las sesiones abiertas de tu cuenta.`;
  document.getElementById('successLink').href = 'login.html';
  document.getElementById('successLink').textContent = 'Ir al inicio de sesión';
  passwordInput.focus();
  // Avisar que el enlace murió ANTES de que el usuario teclee la contraseña dos veces.
  API.get(`/reset/validar?t=${encodeURIComponent(token)}`).catch(mostrarVencido);
} else {
  // Sin sesión no hay nada que cambiar; api.js redirige al login en el 401.
  API.me().catch(() => {});
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  formError.hidden = true;

  if (passwordInput.value.length < MIN_PASSWORD_LENGTH) {
    showError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
    return passwordInput.focus();
  }
  if (passwordInput.value !== confirmationInput.value) {
    showError('Las contraseñas no coinciden.');
    return confirmationInput.focus();
  }

  setLoading(true);
  try {
    const r = token
      ? await API.post('/reset/confirmar', { t: token, nueva: passwordInput.value })
      : await API.post('/password', { actual: actualInput.value, nueva: passwordInput.value });
    updateView.hidden = true;
    successView.hidden = false;
    if (r.sesiones_cerradas) {
      document.getElementById('successDetail').textContent = token
        ? `Tu nueva contraseña se guardó. Se cerraron ${r.sesiones_cerradas} sesión(es) abiertas; vuelve a entrar.`
        : `Tu nueva contraseña se guardó. Se cerraron ${r.sesiones_cerradas} sesión(es) abiertas en otros dispositivos.`;
    }
  } catch (err) {
    // El backend contesta lo mismo para token gastado, vencido o inventado.
    if (token && /ya no es válido/i.test(err.message)) return mostrarVencido();
    showError(err.message);
    setLoading(false);
  }
});

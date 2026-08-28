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
  submitButton.querySelector('span').textContent = loading ? 'Iniciando sesión…' : 'Iniciar sesión';
}

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

// Si ya hay sesión, no tiene caso mostrar el formulario.
API.me().then(() => location.replace('index.html')).catch(() => {});

form.addEventListener('submit', async event => {
  event.preventDefault();
  clearError();
  if (!validateCredentials()) return;

  setLoading(true);
  try {
    await API.login(emailInput.value.trim(), passwordInput.value);
    location.replace('index.html');
  } catch (err) {
    // 429 del limitador trae su propio mensaje; el resto se generaliza para no
    // revelar si el correo existe.
    showError(/Demasiados/.test(err.message)
      ? err.message
      : 'Correo o contraseña incorrectos.');
    setLoading(false);
  }
});

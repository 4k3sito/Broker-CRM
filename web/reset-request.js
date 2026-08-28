// Solicitud de recuperación. La vista de éxito se muestra SIEMPRE que el servidor
// responda 200, exista o no la cuenta: el endpoint ya devuelve lo mismo en ambos
// casos y aquí no se puede distinguir. Es lo que impide que el formulario sirva
// para averiguar qué correos están registrados.
const form = document.getElementById('requestForm');
const emailInput = document.getElementById('email');
const submitButton = document.getElementById('submitButton');
const formError = document.getElementById('formError');
const requestView = document.getElementById('requestView');
const successView = document.getElementById('successView');

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.querySelector('span').textContent = loading ? 'Enviando…' : 'Enviar enlace';
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  formError.hidden = true;

  const email = emailInput.value.trim();
  if (!email.includes('@')) {
    formError.textContent = 'Escribe un correo válido.';
    formError.hidden = false;
    return emailInput.focus();
  }

  setLoading(true);
  try {
    await API.post('/reset/solicitar', { email });
    requestView.hidden = true;
    successView.hidden = false;
  } catch (err) {
    // Un 429 del límite de intentos sí se muestra: es del solicitante, no de la cuenta.
    formError.textContent = err.message;
    formError.hidden = false;
    setLoading(false);
  }
});

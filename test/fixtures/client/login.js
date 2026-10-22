// The phrase page's show/hide control (SPEC 3.1). The button is hidden in the
// HTML so the page works without JavaScript; this file reveals it and switches
// the field between hidden and visible, keeping the focus and the cursor in it.
(function () {
  var field = document.getElementById("phrase");
  var button = document.getElementById("show-phrase");
  if (!field || !button) return;

  button.hidden = false;
  button.addEventListener("click", function () {
    var start = field.selectionStart;
    var end = field.selectionEnd;
    var show = field.type === "password";

    field.type = show ? "text" : "password";
    button.textContent = show ? "Hide phrase" : "Show phrase";
    button.setAttribute("aria-pressed", show ? "true" : "false");
    field.focus();

    if (typeof start === "number" && typeof end === "number") {
      field.setSelectionRange(start, end);
    }
  });
})();

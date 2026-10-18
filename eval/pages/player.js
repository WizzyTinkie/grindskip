// ?src=<media path>; the driver controls the element directly. A separate
// file, so the page also works under a strict CSP (?csp=strict).
document.getElementById('v').src = new URLSearchParams(location.search).get('src');

// Empty string means "same origin" — every API call is `${environment.apiUrl}/api/...`,
// and since server.js now serves this Angular build itself (see the static-serving
// block at the bottom of server.js), the frontend and backend are always on the
// same origin. Only set this to an absolute URL if the frontend is ever served
// from somewhere other than the backend itself.
export const environment = {
  production: false,
  apiUrl: ''
};

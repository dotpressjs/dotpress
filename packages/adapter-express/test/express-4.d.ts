// Express 4 is installed under an alias to test both major versions. Its
// runtime API used by the tests is covered by the Express 5 types.
declare module 'express-4' {
  import express from 'express'
  export default express
}

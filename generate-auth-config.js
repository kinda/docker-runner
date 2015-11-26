'use strict';

var auth = {
  username: 'mvila',
  password: '*****************',
  auth: '',
  email: 'mvila@3base.com',
  serveraddress: 'https://index.docker.io/v1'
};

var authConfig = JSON.stringify(auth);
authConfig = new Buffer(authConfig).toString('base64');
console.log(authConfig);

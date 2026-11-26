#!/bin/sh
# Create a development CA and a certificate for the fake suite, once, in /certs.
set -eu
cd /certs
[ -f fake-suite.crt ] && exit 0
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj '/CN=Embermend development CA' -keyout ca.key -out ca.crt
openssl req -newkey rsa:2048 -nodes -subj '/CN=fake-suite' -keyout fake-suite.key -out fake-suite.csr
printf 'subjectAltName=DNS:fake-suite,DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' > fake-suite.ext
openssl x509 -req -in fake-suite.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 365 -extfile fake-suite.ext -out fake-suite.crt
rm -f fake-suite.csr fake-suite.ext ca.key ca.srl
chmod 0644 ca.crt fake-suite.crt && chmod 0600 fake-suite.key

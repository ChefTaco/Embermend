FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y qemu-system-x86 qemu-utils cloud-image-utils openssh-client ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /lab
ENTRYPOINT ["qemu-system-x86_64"]

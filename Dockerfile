FROM ubuntu:14.04

ADD ./provision.sh /app/
ADD ./slyd/requirements.txt ./slyd/setup.py /app/slyd/
ADD ./slybot/requirements.txt ./slybot/setup.py /app/slybot/

RUN APP_ROOT="/app" /app/provision.sh \
        install_deps \
        install_splash

RUN apt-get install -y curl git && \
    curl --silent --location https://deb.nodesource.com/setup_5.x | sudo bash - && \
    apt-get update && \
    apt-get install -y nodejs && \
    npm cache clear && \
    npm install -g bower && \
    npm install -g ember-cli
ADD . /app
RUN /app/provision.sh install_python_deps configure_nginx
RUN cd /app/slyd && \
    rm -rf node_modules && \ 
    npm install --cache-min 999999 && \
    bower --allow-root install && \
    ember build -e production    

ENV PYTHONPATH /app/slybot:/app/slyd

EXPOSE 9001

WORKDIR /app/slyd

# TODO(dangra): fix handling of nginx service, it won't be restarted in case if crashed.
CMD service nginx start; bin/slyd -p 9002 -r /app/slyd/dist

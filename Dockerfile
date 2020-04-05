FROM node:10

# Install
WORKDIR /app/
COPY ./package.json .
COPY ./yarn.lock .
RUN npm install -g yarn --force
RUN yarn
ADD . .

RUN yarn run build

EXPOSE 80
CMD yarn run prod

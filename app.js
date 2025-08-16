require('dotenv').config();
require('./models/connection')

var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
//ajout de i18n pour la gestion des traductions
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');
const middleware = require('i18next-http-middleware');

i18next
  .use(Backend)
  .use(middleware.LanguageDetector)
  .init({
    lng: 'fr',
    fallbackLng: 'fr',
    preload: ['en', 'fr'],
    backend: {
      loadPath: __dirname + '/traductions/{{lng}}/translation.json'
    }
  });
//ajout du module cron créé pour la gestion automatique des notifications utilisateurs
require('./modules/cronNotification')

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var productRouter = require('./routes/product');
var forgotRouter = require('./routes/forgot');
var notifications = require('./routes/notifications');
var shoppinglistsRouter = require('./routes/shoppinglists');
var recipeRouter= require('./routes/recipe');
const favoritesRouter = require('./routes/favoritesRecipes');

var app = express();
//important ajout du module cors pour communication frontend a backend
const cors = require('cors');
app.use(cors());

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(middleware.handle(i18next));

app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/product', productRouter);
app.use('/forgot', forgotRouter);
app.use('/notifications', notifications);
app.use('/shoppinglists', shoppinglistsRouter);
app.use('/recipe',recipeRouter)
app.use('/favorites', favoritesRouter);

module.exports = app;

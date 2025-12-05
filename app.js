require('dotenv').config();
require('./models/connection');

var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

// i18n
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');
const middleware = require('i18next-http-middleware');

// Middlewares custom
const checkToken = require('./middlewares/checkToken');
const slideSession = require('./middlewares/slideSession');

// Cron premium
const { startPremiumSyncJob } = require('./utils/premiumSync');
startPremiumSyncJob();

// Cron notifications
require('./modules/cronNotification');

// Routers
var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var productRouter = require('./routes/product');
var notifications = require('./routes/notifications');
var shoppinglistsRouter = require('./routes/shoppinglists');
var recipeRouter = require('./routes/recipe');
var favoritesRouter = require('./routes/favoritesRecipes');
var auth = require('./routes/auth');
var planning = require('./routes/planning');

// INITIALISATION DE EXPRESS
var app = express();

// 🔐 Important pour les reverse proxies type Nginx
app.set("trust proxy", 1);

// 🌍 CORS
const cors = require('cors');
app.use(cors());

// 🌐 Logger des requêtes (ton logger custom)
app.use((req, res, next) => {
  console.log(`📩 ${req.method} ${req.url}`);
  next();
});

// 📄 Morgan (logs formatés)
app.use(logger('dev'));

// Middlewares Express
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// i18n middleware
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

app.use(middleware.handle(i18next));

//
// ROUTES
//

// Public
app.use('/', indexRouter);
app.use('/auth', auth);

// Mixte
app.use('/users', usersRouter);

// Privées (ordre important : checkToken puis slideSession)
app.use('/product',       checkToken, slideSession, productRouter);
app.use('/notifications', checkToken, slideSession, notifications);
app.use('/shoppinglists', checkToken, slideSession, shoppinglistsRouter);
app.use('/recipe',        checkToken, slideSession, recipeRouter);
app.use('/favorites',     checkToken, slideSession, favoritesRouter);
app.use('/planning',      checkToken, slideSession, planning);

module.exports = app;
 
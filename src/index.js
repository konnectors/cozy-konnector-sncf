// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://8f145261a4bd46b9ab2a3b08a4d63d47:66141551cbe848e9ad3b5d6c35022093@sentry.cozycloud.cc/82'

const moment = require('moment-timezone')
const bluebird = require('bluebird')
const cheerio = require('cheerio')

const {
  log,
  saveBills,
  CookieKonnector,
  errors
} = require('cozy-konnector-libs')
let rq

class SncfConnector extends CookieKonnector {
  async fetch(fields) {
    try {
      await this.tryFetch(fields)
    } catch (err) {
      if (err.statusCode === 429) {
        const $ = cheerio.load(err.response.body)
        log('info', err.response.request.uri.href)
        log('info', $('.g-recaptcha').data('sitekey'))
        throw new Error(errors.CAPTCHA_RESOLUTION_FAILED)
      } else {
        throw err
      }
    }
  }

  async tryFetch(fields) {
    rq = this.requestFactory({
      //      debug: true,
      cheerio: false,
      json: false,
      jar: true
    })
    if (!(await this.testSession())) {
      await this.logIn(fields)
    }
    rq = this.requestFactory({
      json: true,
      jar: true,
      cheerio: false,
      headers: {
        Accept: '*/*'
      }
    })
    const currentOrders = await getCurrentOrders()
    rq = this.requestFactory({
      json: false,
      jar: true,
      cheerio: true
    })
    const pastOrders = await getPastOrders()
    await saveBills(currentOrders.concat(pastOrders), fields, {
      identifiers: 'SNCF',
      dateDelta: 10,
      amountDelta: 0.1
    })
  }

  async logIn(fields) {
    try {
      // Directly post credentials
      log('info', 'Logging in in SNCF.')
      const body = await rq.post({
        uri: 'https://www.oui.sncf/espaceclient/authentication/flowSignIn',
        form: {
          login: fields.login,
          password: fields.password
        }
      })
      if (body.includes('Authentification incorrecte')) {
        log('error', `${body}`)
        throw new Error(errors.LOGIN_FAILED)
      }
    } catch (err) {
      if (err.message === 'LOGIN_FAILED') {
        throw err
      } else if (err.statusCode === 429) {
        log('error', 'captcha during login')
        throw err
      } else {
        log('error', 'error after login')
        throw new Error(errors.VENDOR_DOWN)
      }
    }
  }

  async testSession() {
    log('info', 'Test the validity of old session')
    try {
      const resp = await rq({
        uri: 'https://www.oui.sncf/espaceclient/commandes-en-cours',
        resolveWithFullResponse: true,
        followRedirect: false,
        followAllRedirects: false
      })
      if (
        resp.statusCode === 200 &&
        resp.request.uri.href ===
          'https://www.oui.sncf/espaceclient/commandes-en-cours'
      ) {
        log('info', 'Session valid')
        return true
      } else {
        log('info', 'Session invalid')
        return false
      }
    } catch (err) {
      log('info', 'Getting error during testing, Session invalid')
      return false
    }
  }
}

async function getPastOrders() {
  const $ = await getPastOrderPage()
  return parseOrderPage($)
}

function getPastOrderPage() {
  log('info', 'Download past orders HTML page...')
  return rq(
    'https://www.oui.sncf/espaceclient/ordersconsultation/showOrdersForAjaxRequest?pastOrder=true&pageToLoad=1'
  )
}

async function getCurrentOrders() {
  log('info', 'Download current orders ...')
  const body = await rq(
    'https://www.oui.sncf/espaceclient/ordersconsultation/getCurrentUserOrders'
  )
  if (!body.trainOrderList) {
    log('error', 'Current Orders malformed')
    throw new Error(errors.VENDOR_DOWN)
  }
  // looking for ebillets for each entry
  const entries = await bluebird.mapSeries(
    body.trainOrderList,
    async trainOrder => {
      const code = Object.keys(trainOrder.pnrsAndReceipt).pop()
      const date = new Date(trainOrder.outwardDate)
      let entry = {
        date,
        amount: trainOrder.amount,
        vendor: 'VOYAGES SNCF',
        type: 'transport',
        content: `${trainOrder.originLabel}/${
          trainOrder.destinationLabel
        } - ${code}`
      }

      if (trainOrder.deliveryMode !== 'EADN') {
        // délivré par courrier
        const body = await rq(
          `https://www.oui.sncf/vsa/api/order/fr_FR/${
            trainOrder.owner
          }/${code}?source=vsa`
        )
        if (isThereAPdfTicket(body, code)) {
          let creationDate = body.order.trainFolders[code].creationDate
          creationDate = creationDate
            .replace(/-/g, '')
            .replace(/T/g, '')
            .replace(/:/g, '')
          creationDate = creationDate.substr(0, creationDate.length - 2)

          Object.assign(entry, {
            fileurl:
              'https://ebillet.voyages-sncf.com/ticketingServices/public/e-ticket/',
            filename: getFileName(moment(date), '_ebillet'),
            requestOptions: {
              method: 'POST',
              json: true,
              headers: {
                Accept: 'application/json, text/plain, */*'
              },
              body: {
                lang: 'FR',
                pnrRefs: [
                  {
                    pnrLocator: code,
                    creationDate: creationDate,
                    passengerName: trainOrder.owner
                  }
                ],
                market: 'VSC',
                caller: 'VSA_FR'
              }
            }
          })
        }

        return entry
      }
    }
  )
  return entries
}

function parseOrderPage($) {
  // Parse the orders page
  const result = []
  const $rows = $('.order')
  $rows.each(function eachRow() {
    const $row = $(this)
    const orderInformations = parseOrderRow($, $row)

    const date = moment(orderInformations.date, 'DD/MM/YYYY')
    const bill = {
      date: date.toDate(),
      amount: parseFloat(orderInformations.amount),
      vendor: 'VOYAGES SNCF',
      type: 'transport',
      content: `${orderInformations.label} - ${orderInformations.reference}`
    }

    if (orderInformations.pdfurl) {
      Object.assign(bill, {
        fileurl: orderInformations.pdfurl,
        filename: getFileName(date)
      })
    }
    result.push(bill)
  })
  return result
}

function parseOrderRow($, $row) {
  const reference = $row
    .find(`.order__detail [data-auto=ccl_orders_travel_number]`)
    .text()
    .trim()
  const label = $row
    .find('.order__top .texte--insecable')
    .map(function mapRow() {
      return $(this)
        .text()
        .trim()
    })
    .get()
    .join('/')
  const date = $row
    .find('.order__detail div:nth-child(2) .texte--important')
    .eq(0)
    .text()
    .trim()
  const amount = $row
    .find('.order__detail div:nth-child(3) .texte--important')
    .eq(0)
    .text()
    .trim()
    .replace(' €', '')

  const result = {
    reference,
    label,
    date,
    amount
  }

  const $filelink = $row.find('.order__detail a:not([target=_blank])')
  if ($filelink.length > 0) {
    result.pdfurl = $filelink.eq(0).attr('href')
  }

  return result
}

function getFileName(date, suffix = '') {
  return `${moment(date).format('YYYYMMDD')}${suffix}_sncf.pdf`
}

function isThereAPdfTicket(body, code) {
  // Some rare 'E-billets' are not eligible for PDF
  if (body.status === 'NOT_ELIGIBLE') {
    return false
  }
  // TKD seems to correspond to ebillet but since I have no access to the api documentation
  // there might be more cases
  return (
    body.order.trainFolders[code].deliveryMode.type === 'TKD' &&
    body.order.trainFolders[code].ticketlessStatus !== 'FULL'
  )
}

const connector = new SncfConnector()

connector.run()

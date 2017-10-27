'use strict'

const moment = require('moment-timezone')
const bluebird = require('bluebird')

const {log, BaseKonnector, saveBills, request} = require('cozy-konnector-libs')
let rq = request({
  // debug: true,
  cheerio: false,
  json: true,
  jar: true
})

module.exports = new BaseKonnector(function fetch (fields) {
  let entries = []
  return logIn.call(this, fields)
  .then(() => getCurrentOrders())
  .then(result => {
    entries = entries.concat(result)
  })
  .then(() => getPastOrderPage())
  .then($ => parseOrderPage($))
  .then(result => {
    entries = entries.concat(result)
  })
  .then(() => saveBills(entries, fields.folderPath, {
    timeout: Date.now() + 60 * 1000,
    identifiers: 'SNCF',
    dateDelta: 10,
    amountDelta: 0.1
  }))
  .catch(err => console.log(err, 'error caught'))
})

function logIn (fields) {
  // Directly post credentials
  log('info', 'Logging in in SNCF.')
  return rq({
    uri: 'https://espace-client.voyages-sncf.com/espaceclient/authentication/flowSignIn',
    method: 'POST',
    form: {
      login: fields.login,
      password: fields.password
    }
  })
  .catch(err => {
    log('debug', err.message, 'Login error')
    this.terminate('LOGIN_FAILED')
  })
  .then(body => {
    if (body.error) {
      log('debug', `${body.error.code}: ${body.error.libelle}`)
      this.terminate('LOGIN_FAILED')
    }
  })
}

function getPastOrderPage () {
  rq = request({
    json: false,
    cheerio: true
  })

  log('info', 'Download past orders HTML page...')
  return rq('https://espace-client.voyages-sncf.com/espaceclient/ordersconsultation/showOrdersForAjaxRequest?pastOrder=true&pageToLoad=1')
}

function getCurrentOrders () {
  rq = request({
    json: true,
    cheerio: false
  })

  log('info', 'Download current orders ...')
  return rq('https://secure.voyages-sncf.com/espaceclient/ordersconsultation/getCurrentUserOrders')
  .then(body => {
    return bluebird.mapSeries(body.trainOrderList, trainOrder => {
      const code = Object.keys(trainOrder.pnrsAndReceipt).pop()
      return rq(`https://www.voyages-sncf.com/vsa/api/order/fr_FR/${trainOrder.owner}/${code}?source=vsa`)
      .then(body => {
        let creationDate = body.order.trainFolders[code].creationDate
        creationDate = creationDate
          .replace(/-/g, '')
          .replace(/T/g, '')
          .replace(/:/g, '')
        creationDate = creationDate.substr(0, creationDate.length - 2)
        const date = new Date(trainOrder.outwardDate)
        return {
          date,
          amount: trainOrder.amount,
          vendor: 'VOYAGES SNCF',
          type: 'transport',
          content: `${trainOrder.originLabel}/${trainOrder.destinationLabel} - ${code}`,
          fileurl: 'https://ebillet.voyages-sncf.com/ticketingServices/public/e-ticket/',
          filename: getFileName(moment(date), '_ebillet'),
          requestOptions: {
            method: 'POST',
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
        }
      })
    })
  })
}

function parseOrderPage ($) {
  // Parse the orders page
  const result = []
  const $rows = $('.commande')
  $rows.each(function eachRow () {
    const $row = $(this)
    const orderInformations = parseOrderRow($, $row)

    const date = moment(orderInformations.date, 'DD/MM/YY')
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

function parseOrderRow ($, $row) {
  const reference = $row.find('.commande__detail div:nth-child(1) .texte--important')
                        .eq(0)
                        .text()
                        .trim()
  const label = $row.find('.commande__haut .texte--insecable')
                    .map(function mapRow () {
                      return $(this).text().trim()
                    })
                    .get()
                    .join('/')
  const date = $row.find('.commande__detail div:nth-child(2) .texte--important')
                   .eq(0)
                   .text()
                   .trim()
  const amount = $row.find('.commande__detail div:nth-child(3) .texte--important')
                     .eq(0)
                     .text()
                     .trim()
                     .replace(' €', '')

  const $link = $row.find('.commande__bas a')
  // Boolean, the order is not always a travel (could be a discount card...)
  const isTravel = $link.text().trim().indexOf('voyage') !== -1

  const result = {
    reference,
    label,
    date,
    amount,
    isTravel
  }

  const $filelink = $row.find('.commande__detail a:not([target=_blank])')
  if ($filelink.length > 0) {
    result.pdfurl = $filelink.eq(0).attr('href')
  }

  return result
}

function getFileName (date, suffix = '') {
  return `${moment(date).format('YYYYMMDD')}${suffix}_sncf.pdf`
}

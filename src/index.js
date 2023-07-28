import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor, { TimeoutError } from 'p-wait-for'
import { format } from 'date-fns'
const log = Minilog('ContentScript')
Minilog.enable('sncfCCC')

const baseUrl = 'https://sncf-connect.com'
const preLoginPage = 'https://www.sncf-connect.com/app/account'

let jsonTrips = []
// The override here is needed to intercept XHR requests made during the navigation
// The website respond with an XHR containing a JSON with all trips information, avoiding a lot of navigation.
var proxiedSend = window.XMLHttpRequest.prototype.send

window.XMLHttpRequest.prototype.send = function () {
  var originalResponse = this
  originalResponse.addEventListener('readystatechange', function () {
    if (originalResponse.readyState === 4) {
      if (originalResponse.responseURL.includes('/bff/api/v1/trips')) {
        jsonTrips.push(JSON.parse(originalResponse.response))
      }
    }
  })
  return proxiedSend.apply(this, [].slice.call(arguments))
}

class SncfContentScript extends ContentScript {
  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.runInWorker('clickPreLoginButton')
    await this.waitForElementInWorker('#login')
  }

  onWorkerEvent(event, payload) {
    if (event === 'loginSubmit') {
      this.log('info', 'received loginSubmit, blocking user interactions')
      this.blockWorkerInteractions()
    } else if (event === 'loginError') {
      this.log(
        'info',
        'received loginError, unblocking user interactions: ' + payload?.msg
      )
      this.unblockWorkerInteractions()
    }
  }

  async ensureAuthenticated({ account }) {
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    this.log('info', '🤖 ensureAuthenticated')
    // if (!account) {
    //   await this.ensureNotAuthenticated()
    // }
    // we need to reach the preLogin page to know if we're already connected before reaching the loginForm
    await this.goto(preLoginPage)
    await Promise.race([
      this.waitForElementInWorker(
        'button[data-test="account-disconnect-button"]'
      ),
      this.waitForElementInWorker('.MuiCardContent-root > div > button')
    ])
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      await this.navigateToLoginForm()
      this.log('info', 'Not authenticated')
      await this.showLoginFormAndWaitForAuthentication()
      if (await this.isElementInWorker('#otpCode')) {
        this.log('info', 'waiting for user inputs for OTP code')
        await this.runInWorkerUntilTrue({
          method: 'waitForOtpCode'
        })
      }
    }
    this.unblockWorkerInteractions()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }
    return true
  }

  onWorkerReady() {
    const button = document.querySelector('input[type=submit]')
    if (button) {
      button.addEventListener('click', () =>
        this.bridge.emit('workerEvent', 'loginSubmit')
      )
    }
    const error = document.querySelector('.error')
    if (error) {
      this.bridge.emit('workerEvent', 'loginError', { msg: error.innerHTML })
    }
  }

  async checkAuthenticated() {
    this.log('info', 'checkAuthenticated starts')
    const passwordField = document.querySelector('#pass1')
    const loginField = document.querySelector('#login')
    if (passwordField && loginField) {
      const userCredentials = await this.findAndSendCredentials.bind(this)(
        loginField,
        passwordField
      )
      this.log('info', "Sending user's credentials to Pilot")
      this.sendToPilot({
        userCredentials
      })
    }
    // Detect otp after login
    if (document.querySelector('#otpCode')) {
      this.log('info', 'OTP needed')
      await this.waitForOtpCode()
      return true
    }

    return Boolean(
      document.querySelector('button[data-test="account-disconnect-button"]')
    )
  }

  async findAndSendCredentials(loginField, passwordField) {
    this.log('info', 'findAndSendCredentials starts')
    let userLogin = loginField.value
    let userPassword = passwordField.value
    const userCredentials = {
      email: userLogin,
      password: userPassword
    }
    return userCredentials
  }

  async showLoginFormAndWaitForAuthentication() {
    log.debug('showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    await this.navigateToPersonnalInfos()
    await this.waitForElementInWorker(
      'a[href="https://tgvinoui.sncf/compte/informations/modification-identifiant"]'
    )
    await this.runInWorker('getIdentity')
    if (this.store.userIdentity.email) {
      return {
        sourceAccountIdentifier: this.store.userIdentity.email
      }
    } else {
      throw new Error('No user data identifier, the konnector should be fixed')
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    if (this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }
    await this.saveIdentity(this.store.userIdentity)
    await this.navigateToBillsPage()
    await this.runInWorkerUntilTrue({
      method: 'waitForInterception'
    })
    const bills = await this.runInWorker('getBills')
    await this.saveBills(bills, {
      context,
      fileIdAttributes: ['vendorRef', 'filename'],
      contentType: 'application/pdf',
      qualificationLabel: 'transport_invoice'
    })
  }

  async navigateToPersonnalInfos() {
    this.log('info', 'navigateToPersonnalInfos starts')
    await this.runInWorker('findAndClickInfosButton')
  }

  async navigateToBillsPage() {
    this.log('info', 'navigateToBillsPage starts')
    await this.clickAndWait('a[href="/app/trips"]', '#nav-tab-1')
    await this.clickAndWait('#nav-tab-1', 'li[data-test="trip"]')
  }

  async waitForOtpCode() {
    this.log('info', 'waitForOtpCode starts')
    await waitFor(
      () => {
        const continueButton = document.querySelector('#accessAccount')
        const logoutButton = document.querySelector(
          'button[data-test="account-disconnect-button"]'
        )
        if (continueButton) {
          continueButton.click()
        }
        if (logoutButton) return true
        else return false
      },
      {
        interval: 1000,
        timeout: {
          // It has been agreed that when we're waiting for a user's input for an otp/2fa code
          // we're waiting until the konnector crash wth context deadline exceeded so the user got plenty of time to fill up his code
          milliseconds: Infinity,
          message: new TimeoutError('waitForOtpCode timed out after 30000ms')
        }
      }
    )
    return true
  }

  async clickPreLoginButton() {
    this.log('info', 'clickPreLoginButton starts')
    const buttons = document.querySelectorAll(
      '.MuiCardContent-root > div > button'
    )
    for (const button of buttons) {
      if (button.textContent === 'Se connecter') {
        button.click()
      }
    }
  }

  async findAndClickInfosButton() {
    this.log('info', 'findAndClickInfosButton starts')
    const cards = document.querySelectorAll('div[data-test="card-arrow"]')
    for (const card of cards) {
      if (
        card.querySelector('.MuiTypography-root').textContent ===
        'Vos informations'
      ) {
        card.querySelector('button').click()
        break
      }
    }
  }

  async getIdentity() {
    const nameBirthPhoneElements = document
      .querySelector('div[data-test="identity-summary-info-container"]')
      .querySelectorAll('[data-cy-element="identity-summary-label"]')
    const fullName = nameBirthPhoneElements[0].textContent
    const [givenName, familyName] = fullName.split(' ')
    // we split on 'le ' because the found string starts with "Né le"
    const birthDate = nameBirthPhoneElements[1].textContent.split('le ')[1]
    const phoneNumber = nameBirthPhoneElements[2].textContent
    // Here it's needed to fetch the 'a' element before trying to reach the wanted element
    // because there's loads of elements with the same class
    const email = document
      .querySelector(
        'a[href="https://tgvinoui.sncf/compte/informations/modification-identifiant"]'
      )
      .querySelector('.MuiTypography-subtitle1').textContent
    let userIdentity = {
      name: {
        givenName,
        familyName
      },
      email,
      birthDate,
      phone: [
        // Here the phone they ask you on the website is to be able to send you messages for train infos
        // meaning it could only be a mobile phone.
        {
          number: phoneNumber,
          type: 'mobile'
        }
      ]
    }
    await this.sendToPilot({ userIdentity })
  }

  async waitForInterception() {
    this.log('info', 'waitForInterception starts')
    await waitFor(
      () => {
        // jsonTrips.length must be 2 as the website load twice the data, once when you reach the bills page
        // and once more when you click on the passedTrips button
        if (jsonTrips.length === 2) return true
        else return false
      },
      {
        interval: 1000,
        timeout: {
          milliseconds: 30000,
          message: new TimeoutError(
            'waitForInterception timed out after 30000ms'
          )
        }
      }
    )
    return true
  }

  async getBills() {
    this.log('info', 'getBills starts')
    const foundBills = this.findPassedTrips()
    return foundBills
  }

  findPassedTrips() {
    this.log('info', 'findPassedTrips starts')
    // we're poping the array to get just the last entry as it is the json for passed trips
    const foudTripsInfos = jsonTrips.pop()
    const foundTrips = foudTripsInfos.response.passedTrips
    const allBills = []
    for (const oneTrip of foundTrips) {
      if (oneTrip.trip.isRoundTrip) {
        this.log('debug', 'This trip is a round trip')
        const bills = this.handleRoundTrip(oneTrip)
        for (const oneBill of bills) {
          if (oneBill === null) {
            this.log('info', 'No pdf attached to this bill, jumping it')
            continue
          }
          allBills.push(oneBill)
        }
      } else {
        this.log('debug', 'This trip is a one way trip')
        const bill = this.handleSingleTrip(oneTrip)
        if (bill === null) {
          this.log('info', 'No pdf attached to this bill, jumping it')
          continue
        }
        allBills.push(bill)
      }
    }
    return allBills
  }

  handleRoundTrip(foundTrip) {
    this.log('info', 'handleRoundTrip starts')
    let allTrips = []
    // We're using 2 as the loop limit because you only get 2 trips per roundTrip
    for (let i = 0; i < 2; i++) {
      const trip = foundTrip.trip
      const journeyValue = i === 0 ? 'outwardJourney' : 'inwardJourney'
      // tripProofDetails could be empty and tripProofOperation could be present or not. If it's present, there's not necesarily a pdf to download.
      const hasPdf = Boolean(
        trip.tripDetails.tripProofDetails[i]?.tripProofOperation?.url
      )
      if (!hasPdf) {
        allTrips.push(null)
        continue
      }

      const vendorRef = trip.id
      const departureDate = new Date(
        trip.tripDetails[journeyValue].departureDate
      )
      const arrivalDate = new Date(trip.tripDetails[journeyValue].arrivalDate)
      const originStation = trip.tripDetails[journeyValue].originLabel
      const destinationStation = trip.tripDetails[journeyValue].destinationLabel
      const tripDuration = trip.tripDetails[journeyValue].duration
      const tripReference = trip.tripDetails[journeyValue].references[0]
      // There an invisible character between the price and the currency.
      // To avoid any problems, we replace this char with it's "visible" version
      const amountAndCurrency = trip.tripDetails.tripProofDetails[
        i
      ].priceLabel.replace(/\s/g, ' ')
      const [amount, currency] = amountAndCurrency.split(' ')
      const totalAmount = trip.tripDetails[journeyValue].priceLabel
        .replace(/\s/g, ' ')
        .split(' ')[0]
      const fileurl =
        trip.tripDetails.tripProofDetails[i].tripProofOperation.url

      const filename = `${format(
        departureDate,
        'yyyy-MM-dd'
      )}_SNCF_RoundTrip_${originStation}-${destinationStation}_${amount}${currency}.pdf`

      const oneBill = {
        vendor: 'sncf-connect.com',
        // We didn't dispose of a purchase date so we're using the departureDate
        date: departureDate,
        amount: parseInt(amount),
        currency,
        vendorRef,
        filename,
        fileurl,
        trip: {
          departureDate,
          arrivalDate,
          originStation,
          destinationStation,
          tripDuration,
          tripReference,
          totalAmount
        },
        fileAttributes: {
          metadata: {
            contentAuthor: 'SNCF',
            datetime: departureDate,
            datetimeLabel: 'issueDate',
            carbonCopy: true
          }
        }
      }
      allTrips.push(oneBill)
    }
    return allTrips
  }

  handleSingleTrip(foundTrip) {
    this.log('info', 'handleSingleTrip starts')
    const trip = foundTrip.trip
    // tripProofOperation could be present or not. If it's present, there's not necesarily a pdf to download.
    const hasPdf = Boolean(
      trip.tripDetails.outwardJourney.tripProof.tripProofOperation?.url
    )
    if (!hasPdf) {
      return null
    }

    const vendorRef = trip.id
    const departureDate = new Date(
      trip.tripDetails.outwardJourney.departureDate
    )
    const arrivalDate = new Date(trip.tripDetails.outwardJourney.arrivalDate)
    const originStation = trip.originLabel
    const destinationStation = trip.destinationLabel
    const tripDuration = trip.duration
    const tripReference = trip.tripDetails.outwardJourney.references[0]
    // There an invisible character between the price and the currency.
    // To avoid any problems, we replace this char with it's "visible" version
    const amountAndCurrency =
      trip.tripDetails.outwardJourney.priceLabel.replace(/\s/g, ' ')
    const [amount, currency] = amountAndCurrency.split(' ')
    const fileurl =
      trip.tripDetails.outwardJourney.tripProof.tripProofOperation.url

    const filename = `${format(
      departureDate,
      'yyyy-MM-dd'
    )}_SNCF_OneWay_${originStation}-${destinationStation}_${amount}${currency}.pdf`

    const oneBill = {
      vendor: 'sncf-connect.com',
      // We didn't dispose of a purchase date so we're using the departureDate
      date: departureDate,
      amount: parseInt(amount),
      currency,
      vendorRef,
      filename,
      fileurl,
      trip: {
        departureDate,
        arrivalDate,
        originStation,
        destinationStation,
        tripDuration,
        tripReference
      },
      fileAttributes: {
        metadata: {
          contentAuthor: 'SNCF',
          datetime: departureDate,
          datetimeLabel: 'issueDate',
          carbonCopy: true
        }
      }
    }
    return oneBill
  }
}

const connector = new SncfContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'waitForOtpCode',
      'clickPreLoginButton',
      'findAndClickInfosButton',
      'getIdentity',
      'getBills',
      'waitForInterception'
    ]
  })
  .catch(err => {
    log.warn(err)
  })

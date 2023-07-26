import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor, { TimeoutError } from 'p-wait-for'
const log = Minilog('ContentScript')
Minilog.enable('sncfCCC')

const baseUrl = 'https://sncf-connect.com'
const preLoginPage = 'https://www.sncf-connect.com/app/account'
const loginPage =
  'https://monidentifiant.sncf/login?scope=openid%20profile%20email&response_type=code&client_id=CCL_01002&redirect_uri=https:%2F%2Fwww.sncf-connect.com%2Fbff%2Fapi%2Fv1%2Fauthenticated-redirect'

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
  }

  async navigateToPersonnalInfos() {
    this.log('info', 'navigateToPersonnalInfos starts')
    await this.runInWorker('findAndClickInfosButton')
  }

  async waitForOtpCode() {
    this.log('info', 'waitForOtpCode starts')
    await waitFor(
      () => {
        if (
          document.querySelector(
            'button[data-test="account-disconnect-button"]'
          )
        )
          return true
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
    // split is on 'le ' because the found string starts with "Né le"
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
}

const connector = new SncfContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'waitForOtpCode',
      'clickPreLoginButton',
      'findAndClickInfosButton',
      'getIdentity'
    ]
  })
  .catch(err => {
    log.warn(err)
  })

'use strict';

const functions = require('firebase-functions');
const mkdirp = require('mkdirp-promise');
const gcs = require('@google-cloud/storage')({keyFilename: 'service-account-credentials.json'});
const admin = require('firebase-admin');
admin.initializeApp();
const spawn = require('child-process-promise').spawn;
const path = require('path');
const os = require('os');
const fs = require('fs');

const THUMB_MAX_HEIGHT = 200;
const THUMB_MAX_WIDTH = 200;
const THUMB_PREFIX = 'thumb_';

const NOTIFICATIONS_TYPE_PUBLISH = "-Kvrz_HswCDZDmTW8Rkp";
const NOTIFICATIONS_TYPE_FOLLOW = "-Kvrz_I-IprNB0ncXlsA";
const NOTIFICATIONS_TYPE_MOMENT = "-Kvrz_Hzx4cdeqaJis_i";

const COLLECTION_BENEFIT = "Benefit";
const COLLECTION_PROFILE_ASSOCIATED = "ProfileAssociated";
const COLLECTION_PROFILE_ASSOCIATED_FOLLOW = "ProfileAssociatedFollow";

exports.generateThumbnail = functions.storage.object().onFinalize((object) => {
  const filePath = object.name;
  const contentType = object.contentType; // This is the image MIME type
  const fileDir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const thumbFilePath = path.normalize(path.join(fileDir, `${THUMB_PREFIX}${fileName}`));
  const tempLocalFile = path.join(os.tmpdir(), filePath);
  const tempLocalDir = path.dirname(tempLocalFile);
  const tempLocalThumbFile = path.join(os.tmpdir(), thumbFilePath);

  if (!contentType.startsWith('image/')) {
    return null;
  }

  if (fileName.startsWith(THUMB_PREFIX)) {
    return null;
  }

  const bucket = gcs.bucket(object.bucket);
  const file = bucket.file(filePath);
  const thumbFile = bucket.file(thumbFilePath);
  const metadata = {
    contentType: contentType,
  };
  
  return mkdirp(tempLocalDir).then(() => {
    return file.download({destination: tempLocalFile});
  }).then(() => {
    // Generate a thumbnail using ImageMagick.
    return spawn('convert', [tempLocalFile, '-thumbnail', `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}>`, tempLocalThumbFile], {capture: ['stdout', 'stderr']});
  }).then(() => {
    // Uploading the Thumbnail.
    return bucket.upload(tempLocalThumbFile, {destination: thumbFilePath, metadata: metadata});
  }).then(() => {
    console.log('Thumbnail uploaded to Storage at', thumbFilePath);
    // Once the image has been uploaded delete the local files to free up disk space.
    fs.unlinkSync(tempLocalFile);
    fs.unlinkSync(tempLocalThumbFile);
    // Get the Signed URLs for the thumbnail and original image.
    const config = {
      action: 'read',
      expires: '03-01-2500',
    };
    return Promise.all([
      thumbFile.getSignedUrl(config),
      file.getSignedUrl(config),
    ]);
  }).then((results) => {
    console.log('Got Signed URLs.');
    const thumbResult = results[0];
    const originalResult = results[1];
    const thumbFileUrl = thumbResult[0];
    const fileUrl = originalResult[0];
    // Add the URLs to the Database
    return admin.firestore().database().ref('images').push({path: fileUrl, thumbnail: thumbFileUrl});
  }).then(() => console.log('Thumbnail URLs saved to database.'));
});

exports.sendFollowNotification = functions.firestore.document(`/${COLLECTION_PROFILE_ASSOCIATED_FOLLOW}/{followId}`)
    .onCreate((snap, context) => {
      const followId = context.params.followId;
      const followerId = snap.data().pafProfileAssociatedId;
      console.log("Este es el seguidor ", followerId);

      return admin.firestore().collection(COLLECTION_PROFILE_ASSOCIATED).doc(followerId).get().then(doc =>{
        const followerUId = doc.data().paAssociatedId;
        console.log("Este es el usuario ", followerUId);

        return admin.firestore().collection("InfoDevice").get().then(snapshot => {
          // Get the list of device notification tokens.
          const getDeviceTokensPromise = snapshot;
          // Get the follower profile.
          const getFollowerProfilePromise = admin.auth().getUser(followerUId);
          // The snapshot to the user's tokens.
          let tokensSnapshot;
          // The array containing all the user's tokens.
          let tokens = [];
          return Promise.all([getDeviceTokensPromise, getFollowerProfilePromise]).then(results => {
            tokensSnapshot = results[0];
            const follower = results[1];

            if (!getDeviceTokensPromise.size>0) {
              return console.log('There are no notification tokens to send to.');
            }
            const payload = {
              notification: {
                title: 'Tienes un nuevo seguidor!',
                body: `${follower.displayName} es ahora tu seguidor.`,
                icon: follower.photoURL
              }
            };
            snapshot.forEach(doc => {
              tokens.push(doc.data().idRegid);
            });
            return admin.messaging().sendToDevice(tokens, payload);
          }).then((response) => {
            // For each message check if there was an error.
            const tokensToRemove = [];
            response.results.forEach((result, index) => {
              const error = result.error;
              if (error) {
                console.error('Failure sending notification to', tokens[index], error);
                // Cleanup the tokens who are not registered anymore.
                if (error.code === 'messaging/invalid-registration-token' ||
                    error.code === 'messaging/registration-token-not-registered') {
                  tokensToRemove.push(tokensSnapshot.ref.child(tokens[index]).remove());
                }
              }
            });
            return Promise.all(tokensToRemove);
          });
        });
      }).catch(err => {
        console.log('Error obteniendo el usuario', err);
      });
    });
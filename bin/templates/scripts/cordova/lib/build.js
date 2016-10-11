/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 * 
 * http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 *  KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/*jshint node: true*/

var Q     = require('q'),
    path  = require('path'),
    shell = require('shelljs'),
    spawn = require('./spawn'),
    check_reqs = require('./check_reqs'),
    fs = require('fs');

var events = require('cordova-common').events;

var projectPath = path.join(__dirname, '..', '..');
var projectName = null;

// These are regular expressions to detect if the user is changing any of the built-in xcodebuildArgs
var buildFlagMatchers = {
    'xcconfig' : /^\-xcconfig\s*(.*)$/,
    'project' : /^\-project\s*(.*)/,
    'archs' : /^(ARCHS=.*)/,
    'target' : /^\-target\s*(.*)/,
    'configuration' : /^\-configuration\s*(.*)/,
    'sdk' : /^\-sdk\s*(.*)/,
    'valid_archs' : /^(VALID_ARCHS=.*)/,
    'configuration_build_dir' : /^(CONFIGURATION_BUILD_DIR=.*)/,
    'shared_precomps_dir' : /^(SHARED_PRECOMPS_DIR=.*)/
};

module.exports.run = function (buildOpts) {

    buildOpts = buildOpts || {};

    if (buildOpts.debug && buildOpts.release) {
        return Q.reject('Only one of "debug"/"release" options should be specified');
    }

    if (buildOpts.device && buildOpts.emulator) {
        return Q.reject('Only one of "device"/"emulator" options should be specified');
    }

    if(buildOpts.buildConfig) {
        if(!fs.existsSync(buildOpts.buildConfig)) {
            return Q.reject('Build config file does not exist:' + buildOpts.buildConfig);
        }
        events.emit('log','Reading build config file:', path.resolve(buildOpts.buildConfig));
        var buildConfig = JSON.parse(fs.readFileSync(buildOpts.buildConfig, 'utf-8'));
        if(buildConfig.ios) {
            var buildType = buildOpts.release ? 'release' : 'debug';
            var config = buildConfig.ios[buildType];
            if(config) {
                ['codeSignIdentity', 'codeSignResourceRules', 'provisioningProfile'].forEach(
                    function(key) {
                        buildOpts[key] = buildOpts[key] || config[key];
                    });
            }
        }
    }

    return check_reqs.run().then(function () {
        return findXCodeProjectIn(projectPath);
    }).then(function (name) {
        projectName = name;
        var extraConfig = '';
        if (buildOpts.codeSignIdentity) {
            extraConfig += 'CODE_SIGN_IDENTITY = ' + buildOpts.codeSignIdentity + '\n';
            extraConfig += 'CODE_SIGN_IDENTITY[sdk=iphoneos*] = ' + buildOpts.codeSignIdentity + '\n';
        }
        if (buildOpts.codeSignResourceRules) {
            extraConfig += 'CODE_SIGN_RESOURCE_RULES_PATH = ' + buildOpts.codeSignResourceRules + '\n';
        }
        if (buildOpts.provisioningProfile) {
            extraConfig += 'PROVISIONING_PROFILE = ' + buildOpts.provisioningProfile + '\n';
        }
        return Q.nfcall(fs.writeFile, path.join(__dirname, '..', 'build-extras.xcconfig'), extraConfig, 'utf-8');
    }).then(function () {
        var configuration = buildOpts.release ? 'Release' : 'Debug';

        events.emit('log','Building project  : ' + path.join(projectPath, projectName + '.xcodeproj'));
        events.emit('log','\tConfiguration : ' + configuration);
        events.emit('log','\tPlatform      : ' + (buildOpts.device ? 'device' : 'emulator'));

        var xcodebuildArgs = getXcodeArgs(projectName, projectPath, configuration, buildOpts.device, buildOpts.buildFlag);
        return spawn('xcodebuild', xcodebuildArgs, projectPath);
    }).then(function () {
        if (!buildOpts.device || buildOpts.noSign) {
            return;
        }
        var buildOutputDir = path.join(projectPath, 'build', 'device');
        var pathToApp = path.join(buildOutputDir, projectName + '.app');
        var pathToIpa = path.join(buildOutputDir, projectName + '.ipa');
        var xcRunArgs = ['-sdk', 'iphoneos', 'PackageApplication',
            '-v', pathToApp,
            '-o', pathToIpa];
        if (buildOpts.codeSignIdentity) {
            xcRunArgs.concat('--sign', buildOpts.codeSignIdentity);
        }
        if (buildOpts.provisioningProfile) {
            xcRunArgs.concat('--embed', buildOpts.provisioningProfile);
        }
        return spawn('xcrun', xcRunArgs, projectPath);
    });
};

/**
 * Searches for first XCode project in specified folder
 * @param  {String} projectPath Path where to search project
 * @return {Promise}            Promise either fulfilled with project name or rejected
 */
function findXCodeProjectIn(projectPath) {
    // 'Searching for Xcode project in ' + projectPath);
    var xcodeProjFiles = shell.ls(projectPath).filter(function (name) {
        return path.extname(name) === '.xcodeproj';
    });

    if (xcodeProjFiles.length === 0) {
        return Q.reject('No Xcode project found in ' + projectPath);
    }
    if (xcodeProjFiles.length > 1) {
        events.emit('warn','Found multiple .xcodeproj directories in \n' +
            projectPath + '\nUsing first one');
    }

    var projectName = path.basename(xcodeProjFiles[0], '.xcodeproj');
    return Q.resolve(projectName);
}

module.exports.findXCodeProjectIn = findXCodeProjectIn;

/**
 * Returns array of arguments for xcodebuild
 * @param  {String}       projectName     Name of xcode project
 * @param  {String}       projectPath     Path to project file. Will be used to set CWD for xcodebuild
 * @param  {String}       configuration   Configuration name: debug|release
 * @param  {Boolean}      isDevice        Flag that specify target for package (device/emulator)
 * @param  {String/Array} buildFlags      Additional build flags for xcodebuild
 * @return {Array}                        Array of arguments that could be passed directly to spawn method
 */
function getXcodeArgs(projectName, projectPath, configuration, isDevice, buildFlags) {
    var xcodebuildArgs;
    var options;
    var buildActions = [ 'build' ];
    var settings;
    var customArgs = {};
    customArgs.otherFlags = [];

    if (buildFlags) {
        if (typeof buildFlags === 'string' || buildFlags instanceof String) {
            parseBuildFlag(buildFlags, customArgs);
        } else { // buildFlags is an Array of strings
            buildFlags.forEach( function(flag) {
                parseBuildFlag(flag, customArgs);
            });
        }
    }

    if (isDevice) {
        options = [
            '-xcconfig', customArgs.xcconfig || path.join(__dirname, '..', 'build-' + configuration.toLowerCase() + '.xcconfig'),
            '-project',  customArgs.project || projectName + '.xcodeproj',
            customArgs.archs || 'ARCHS=armv7 arm64',
            '-target', customArgs.target || projectName,
            '-configuration', customArgs.configuration || configuration,
            '-sdk', customArgs.sdk || 'iphoneos'
        ];
        settings = [
            customArgs.valid_archs || 'VALID_ARCHS=armv7 arm64',
            customArgs.configuration_build_dir || 'CONFIGURATION_BUILD_DIR=' + path.join(projectPath, 'build', 'device'),
            customArgs.shared_precomps_dir || 'SHARED_PRECOMPS_DIR=' + path.join(projectPath, 'build', 'sharedpch')
        ];
    } else { // emulator
        options = [
            '-xcconfig', customArgs.xcconfig || path.join(__dirname, '..', 'build-' + configuration.toLowerCase() + '.xcconfig'),
            '-project', customArgs.project || projectName + '.xcodeproj',
            customArgs.archs || 'ARCHS=x86_64 i386',
            '-target', customArgs.target || projectName,
            '-configuration', customArgs.configuration || configuration,
            '-sdk', customArgs.sdk || 'iphonesimulator'
        ];
        settings = [
            customArgs.valid_archs || 'VALID_ARCHS=x86_64 i386',
            customArgs.configuration_build_dir || 'CONFIGURATION_BUILD_DIR=' + path.join(projectPath, 'build', 'emulator'),
            customArgs.shared_precomps_dir || 'SHARED_PRECOMPS_DIR=' + path.join(projectPath, 'build', 'sharedpch')
        ];
    }
    xcodebuildArgs = options.concat(buildActions).concat(settings).concat(customArgs.otherFlags);
    return xcodebuildArgs;
}

function parseBuildFlag(buildFlag, args) {
    var matched;
    for (var key in buildFlagMatchers) {
        var found = buildFlag.match(buildFlagMatchers[key]);
        if (found) {
            matched = true;
            // found[0] is the whole match, found[1] is the first match in parentheses.
            args[key] = found[1];
            events.emit('warn','Overriding xcodebuildArg: ', buildFlag);
        }
    }

    if (!matched) {
        // If the flag starts with a '-' then it is an xcodebuild built-in option or a
        // user-defined setting. The regex makes sure that we don't split a user-defined
        // setting that is wrapped in quotes. 
        if (buildFlag[0] === '-' && !buildFlag.match(/^.*=(\".*\")|(\'.*\')$/)) {
            args.otherFlags = args.otherFlags.concat(buildFlag.split(' '));
            events.emit('warn','Adding xcodebuildArg: ', buildFlag.split(' '));
        } else {
            args.otherFlags.push(buildFlag);
            events.emit('warn','Adding xcodebuildArg: ', buildFlag);
        }
    }
}

// help/usage function
module.exports.help = function help() {
    console.log('');
    console.log('Usage: build [--debug | --release] [--archs=\"<list of architectures...>\"]');
    console.log('             [--device | --simulator] [--codeSignIdentity=\"<identity>\"]');
    console.log('             [--codeSignResourceRules=\"<resourcerules path>\"]');
    console.log('             [--provisioningProfile=\"<provisioning profile>\"]');
    console.log('    --help                  : Displays this dialog.');
    console.log('    --debug                 : Builds project in debug mode. (Default)');
    console.log('    --release               : Builds project in release mode.');
    console.log('    -r                      : Shortcut :: builds project in release mode.');
    // TODO: add support for building different archs
    // console.log("    --archs   : Builds project binaries for specific chip architectures (`anycpu`, `arm`, `x86`, `x64`).");
    console.log('    --device, --simulator');
    console.log('                            : Specifies, what type of project to build');
    console.log('    --codeSignIdentity      : Type of signing identity used for code signing.');
    console.log('    --codeSignResourceRules : Path to ResourceRules.plist.');
    console.log('    --provisioningProfile   : UUID of the profile.');
    console.log('    --device --noSign       : Builds project without application signing.');
    console.log('');
    console.log('examples:');
    console.log('    build ');
    console.log('    build --debug');
    console.log('    build --release');
    console.log('    build --codeSignIdentity="iPhone Distribution" --provisioningProfile="926c2bd6-8de9-4c2f-8407-1016d2d12954"');
    // TODO: add support for building different archs
    // console.log("    build --release --archs=\"armv7\"");
    console.log('');
    process.exit(0);
};

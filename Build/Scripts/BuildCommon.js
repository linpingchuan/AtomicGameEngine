var fs = require('fs-extra');
var os = require('os');
var path = require("path");
var host = require("./Host");
var atomicRoot = host.atomicRoot;
var glob = require('glob');

var Tslint = require("tslint");

var fso = require('fs');
var buildInfoDir = atomicRoot + "Source/AtomicBuildInfo/";
var editorAppFolder = host.artifactsRoot + "AtomicEditor/";
var toolDataFolder = editorAppFolder + "Resources/ToolData/";
var jsDocFolder = host.artifactsRoot + "Build/JSDoc/";

namespace('build', function() {

    // Linting task
    task('lint_typescript', {
        async: true
    }, function(fileMask, failOnError) {

        console.log("TSLINT: Linting files in " + fileMask);
        var lintConfig = JSON.parse(fs.readFileSync("./Script/tslint.json"));
        var options = {
            configuration: lintConfig,
            formatter: "prose"
        };

        // lint
        // Since TSLint does not yet support recursively searching for files, then we need to
        // create a command per file.  The main issue with this is that it will abort on the first error instead
        // of listing out all lint errors
        glob(fileMask, function(err, results) {
            var lintErrors = [];
            results.forEach(function(filename) {

                var contents = fs.readFileSync(filename, "utf8");

                var ll = new Tslint(filename, contents, options);
                var result = ll.lint();
                if (result.failureCount > 0) {
                    lintErrors.push(result.output);
                }
            });
            if (lintErrors.length > 0) {
                console.warn("TSLINT: WARNING - Lint errors detected");
                console.warn(lintErrors.join(''));
                if (failOnError) {
                    fail("TSLint errors detected");
                }
            }
            complete();
        });
    });

    // precreate script bindgs so they can be picked up by CMake
    task('precreateScriptBindings', {
        async: true
    }, function(clean) {

        if (clean === undefined) {
            clean = true;
        }
        console.log("Precreating script bindings");

        if (clean) {
            common.cleanCreateDir(common.getGenScriptRootDir())
        }

        common.createGenScriptFiles();

        complete();
    });

    function fileExists(filePath)
    {
        try
        {
            return fs.statSync(filePath).isFile();
        }
        catch (err)
        {
            return false;
        }
    }

    task('genAtomicNET', {
      async:true
    }, function(platform, configuration) {

      if (configuration != "Debug" && configuration != "Release")
        configuration = "Release";

      // Compile AtomicNET assemblies
      var cmds = [];

      cmds.push(host.atomicTool + " net compile " + atomicRoot + "Script/AtomicNET/AtomicNETProject.json -platform " + platform + " -config " + configuration);

      jake.exec(cmds, function() {

          complete();

      }, {
          printStdout: true
      });

    })

    task('genscripts', {
        async: true
    }, function(force) {

        // default to true
        if (force != "true" && force != "false") {
            force = "true";
        }

        var anyZero = false;
        if (force != "true") {

            var filenames = common.getGenScriptFilenames();
            for (var i in filenames) {

                if (!fileExists(filenames[i]))
                {
                    console.log("genscripts: file missing, regenerating script bindings: " + filenames[i]);
                    anyZero = true;
                    break;
                }

                var stats = fs.statSync(filenames[i]);
                if (stats["size"] == 0) {
                    console.log("genscripts: file zero size, regenerating script bindings: " + filenames[i]);
                    anyZero = true;
                    break;
                }
            }

            if (!anyZero)
                return;
        }


        process.chdir(atomicRoot);

        var modules = host.getScriptModules();
        var bindCmd = host.atomicTool + " bind \"" + atomicRoot + "\" ";
        var node;
        var tsc = "./Build/node_modules/typescript/lib/tsc";
        var tslint = "./Build/node_modules/tslint/lib/tslint-cli";
        var dtsGenerator = "./Build/node_modules/dts-generator/bin/dts-generator";

        switch(os.platform()) {
            case "win32":
            node = "Build\\Windows\\node\\node.exe";
            break;
            case "darwin":
            node = "Build/Mac/node/node";
            break;
            case "linux":
            node = "Build/Linux/node/node";
            break;
        }

        var cmds = [];
        for (var pkgName in modules) {
            cmds.push(bindCmd + "Script/Packages/" + pkgName + "/");
        }

        if (node) {
            // compile
            cmds.push(node + " " + tsc + " -p ./Script");
            cmds.push(node + " " + tsc + " -p ./Script/AtomicWebViewEditor");

            // generate combined atomic.d.ts
            cmds.push(node + " " + dtsGenerator + " --name Atomic --project ./Script/TypeScript --out ./Script/TypeScript/dist/Atomic.d.ts");

            var lintTask = jake.Task['build:lint_typescript'];

            lintTask.addListener('complete', function () {
                console.log("\n\nLint: Typescript linting complete.\n\n");
                jake.exec(cmds, function() {

                    // copy some external dependencies into the editor modules directory
                    var editorModulesDir = "./Artifacts/Build/Resources/EditorData/AtomicEditor/EditorScripts/AtomicEditor/modules";
                    var webeditorModulesDir = "./Data/AtomicEditor/CodeEditor/source/editorCore/modules";
                    var nodeModulesDir = "./Build/node_modules";
                    fs.mkdirsSync(editorModulesDir);
                    // TypeScript
                    fs.copySync(nodeModulesDir + "/typescript/lib/typescript.js", webeditorModulesDir + "/typescript.js")

                    // copy lib.core.d.ts into the tool data directory
                    fs.mkdirsSync("./Artifacts/Build/Resources/EditorData/AtomicEditor/EditorScripts/AtomicEditor/TypeScriptSupport");
                    fs.copySync("./Build/node_modules/typescript/lib/lib.core.d.ts","./Data/AtomicEditor/TypeScriptSupport/lib.core.d.ts")

                    // copy the combined Atomic.d.ts to the tool data directory
                    fs.copySync("./Script/TypeScript/dist/Atomic.d.ts","./Data/AtomicEditor/TypeScriptSupport/Atomic.d.ts")

                    complete();

                }, {
                    printStdout: true
                });
            });

            lintTask.invoke("{./Script/AtomicEditor/**/*.ts,./Script/AtomicWebViewEditor/**/*.ts}", false);

        } else {
            throw new Error("Node not configured for this platform: " + os.platform());
        }


    });

 
  task('gendocs', {
    async: true
    }, function() {

    fs.copySync(atomicRoot + "Build/Docs/Readme.md", jsDocFolder + "Readme.md");
    fs.copySync(atomicRoot + "Build/Docs/atomic-theme", jsDocFolder + "atomic-theme");

    cmds = [
      "cd " + jsDocFolder + " && echo {} > package.json", // newer versions of npm require package.json to be in the folder or else it searches up the heirarchy
      "cd " + jsDocFolder + " && npm install typedoc",
      "cd " + jsDocFolder + " && ./node_modules/.bin/typedoc --out out " + toolDataFolder + "TypeScriptSupport/Atomic.d.ts --module commonjs --includeDeclarations --mode file --theme atomic-theme --name 'Atomic Game Engine' --readme ./Readme.md",
    ];

    jake.exec(cmds, function() {
        
      common.cleanCreateDir( toolDataFolder + "Docs");

      fs.copySync(jsDocFolder + "out", toolDataFolder + "Docs/JSDocs");
    
      complete();

      console.log( "completed installing API documentation" );

    }, {
        
      printStdout: true

    });

  });
  
  task('genexamples', {
    async: true
    }, function() {
    
    common.cleanCreateDir( toolDataFolder + "AtomicExamples");

    cmds = [
      "git clone https://github.com/AtomicGameEngine/AtomicExamples " + toolDataFolder + "AtomicExamples",
    ];

    jake.exec(cmds, function() {
      fs.removeSync( toolDataFolder + "AtomicExamples/.git" );

      complete();
      console.log( "completed installing example programs" )

        }, {

      printStdout: true

    });

  });



}); // end of build namespace
